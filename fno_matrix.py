# -*- coding: utf-8 -*-
"""
fno_matrix.py  --  the F&O data matrix (user-specified layout, Sep 2026)
=========================================================================
7 rows per stock, one column per 10-minute snapshot. Every value is a RATIO.

  ROWS per script      SOURCE
    CASH VOL           yfinance (equity segment)
    FUT VOL            NSE oi-spurts  (one call, all stocks)
    FUT OI             NSE oi-spurts
    CALL VOL           option chain, ATM +/-5 strikes, nearest expiry
    CALL OI            option chain, ATM +/-5 strikes
    PUT VOL            option chain, ATM +/-5 strikes
    PUT OI             option chain, ATM +/-5 strikes

  COLUMNS
    Symbol | Metric | DelivRatio | PrevDayRatio | PrevLastHrRatio | 09:20 | 09:30 | ... | 15:30

    DelivRatio      prev day delivery %  /  day-before delivery %   (cash row only)
    PrevDayRatio    prev day value       /  day-before value
    PrevLastHrRatio prev day last hour   /  prev day whole day
    time cells      today's cumulative   /  yesterday's full day     (a RATIO)

Arrows (up/down vs the previous cell) are rendered by the Google Sheet script,
so this CSV stays clean numbers.
"""
import os, sys, csv, time
from urllib.parse import quote
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor

import pandas as pd
import yfinance as yf

from oi_live import fetch_oi_spurts

IST      = timezone(timedelta(hours=5, minutes=30))
DATA_D   = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
os.makedirs(DATA_D, exist_ok=True)
STRIKES  = 5          # ATM +/- 5  = 10 strikes
BATCH    = 25
WORKERS  = 5          # parallel option-chain fetches (NSE-friendly)
_IDX     = {"NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"}
METRICS  = ["CASH VOL", "FUT VOL", "FUT OI",
            "CALL VOL", "CALL OI", "PUT VOL", "PUT OI"]


def _now():
    return datetime.now(IST)


def universe():
    p = os.path.join(DATA_D, "fno_list.csv")
    if os.path.exists(p):
        s = [r["Symbol"] for r in csv.DictReader(open(p, encoding="utf-8"))
             if r["Symbol"] not in _IDX]
        if len(s) > 50:
            return sorted(s)
    from morning_signal_bot import FNO_STOCKS
    return sorted(FNO_STOCKS)


# ---------------------------------------------------------------- cash ------
def cash_data(symbols):
    """{sym: {'today':cum, 'yday':vol, 'prev':vol, 'yday_lasthr':vol}}"""
    out = {}
    today = _now().strftime("%Y-%m-%d")
    for i in range(0, len(symbols), BATCH):
        b  = symbols[i:i+BATCH]
        tk = " ".join(x + ".NS" for x in b)
        try:
            dl = yf.download(tk, period="8d", interval="1d", progress=False,
                             auto_adjust=True, group_by="ticker", threads=True)
        except Exception:
            continue
        try:
            m5 = yf.download(tk, period="5d", interval="5m", progress=False,
                             auto_adjust=True, group_by="ticker", threads=True)
        except Exception:
            m5 = None
        for x in b:
            try:
                d = dl[x + ".NS"] if isinstance(dl.columns, pd.MultiIndex) else dl
                v = d.dropna(subset=["Close"])["Volume"].astype(float)
                if len(v) < 3:
                    continue
                rec = {"yday": float(v.iloc[-2]), "prev": float(v.iloc[-3]),
                       "today": 0.0, "yday_lasthr": 0.0}
                if m5 is not None:
                    s = m5[x + ".NS"] if isinstance(m5.columns, pd.MultiIndex) else m5
                    s = s.reset_index()
                    dtc = "Datetime" if "Datetime" in s.columns else s.columns[0]
                    s["dt"] = pd.to_datetime(s[dtc], utc=True).dt.tz_convert(IST)
                    s["d"]  = s["dt"].dt.strftime("%Y-%m-%d")
                    s["hm"] = s["dt"].dt.strftime("%H:%M")
                    s = s.dropna(subset=["Close"])
                    rec["today"] = float(s[s.d == today]["Volume"].fillna(0).sum())
                    days = sorted(x for x in s["d"].unique() if x < today)
                    if days:
                        yd = s[s.d == days[-1]]
                        rec["yday_lasthr"] = float(
                            yd[yd.hm >= "14:15"]["Volume"].fillna(0).sum())
                out[x] = rec
            except Exception:
                continue
    return out


# ------------------------------------------------------------- delivery -----
def delivery_ratio():
    """{sym: prev_day_deliv% / day_before_deliv%} from NSE bhavcopy."""
    from curl_cffi import requests as cffi
    s = cffi.Session(impersonate="chrome")

    def one(d):
        url = ("https://nsearchives.nseindia.com/products/content/"
               f"sec_bhavdata_full_{d.strftime('%d%m%Y')}.csv")
        try:
            r = s.get(url, timeout=20)
            if r.status_code != 200 or len(r.content) < 500:
                return {}
            rows = list(csv.DictReader(r.text.splitlines()))
            out = {}
            for x in rows:
                k = {kk.strip(): vv for kk, vv in x.items() if kk}
                if k.get("SERIES", "").strip() != "EQ":
                    continue
                try:
                    out[k["SYMBOL"].strip()] = float(k.get("DELIV_PER", 0) or 0)
                except Exception:
                    continue
            return out
        except Exception:
            return {}

    d, got = _now().date(), []
    for _ in range(12):
        d -= timedelta(days=1)
        if d.weekday() >= 5:
            continue
        r = one(d)
        if r:
            got.append(r)
        if len(got) == 2:
            break
    if len(got) < 2:
        return {}
    prev, before = got[0], got[1]
    return {k: round(prev[k] / before[k], 3)
            for k in prev if before.get(k, 0) > 0}


# -------------------------------------------------------------- options -----
def _chain_session():
    from curl_cffi import requests as cffi
    s = cffi.Session(impersonate="chrome")
    s.get("https://www.nseindia.com/option-chain", timeout=15)
    time.sleep(0.5)
    return s


_H = {"Referer": "https://www.nseindia.com/option-chain",
      "Accept": "application/json, text/plain, */*"}


def option_data(symbols):
    """{sym: {'call_vol','call_oi','put_vol','put_oi'}} over ATM +/-5 strikes."""
    sessions = [_chain_session() for _ in range(WORKERS)]
    out = {}

    def one(job):
        idx, sym = job
        s = sessions[idx % WORKERS]
        try:
            ci = s.get("https://www.nseindia.com/api/option-chain-contract-info"
                       f"?symbol={quote(sym)}", headers=_H, timeout=15)
            exps = ci.json().get("expiryDates", [])
            if not exps:
                return sym, None
            r = s.get("https://www.nseindia.com/api/option-chain-v3"
                      f"?type=Equity&symbol={quote(sym)}&expiry={quote(exps[0])}",
                      headers=_H, timeout=20)
            rec = r.json().get("records", {})
            rows, spot = rec.get("data", []), float(rec.get("underlyingValue", 0) or 0)
            if not rows or spot <= 0:
                return sym, None
            rows = sorted(rows, key=lambda z: float(z.get("strikePrice", 0) or 0))
            ks = [float(z.get("strikePrice", 0) or 0) for z in rows]
            atm = min(range(len(ks)), key=lambda i: abs(ks[i] - spot))
            sel = rows[max(0, atm - STRIKES): atm + STRIKES]
            cv = co = pv = po = 0
            for z in sel:
                ce, pe = z.get("CE") or {}, z.get("PE") or {}
                cv += int(float(ce.get("totalTradedVolume", 0) or 0))
                co += int(float(ce.get("openInterest", 0) or 0))
                pv += int(float(pe.get("totalTradedVolume", 0) or 0))
                po += int(float(pe.get("openInterest", 0) or 0))
            return sym, {"call_vol": cv, "call_oi": co,
                         "put_vol": pv, "put_oi": po}
        except Exception:
            return sym, None

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for sym, d in ex.map(one, enumerate(symbols)):
            if d:
                out[sym] = d
    return out


# ------------------------------------------------------------- assemble -----
def path_for(day):
    return os.path.join(DATA_D, f"matrix_{day}.csv")


def load_or_init(day, symbols, deliv):
    p = path_for(day)
    if os.path.exists(p):
        return pd.read_csv(p)
    rows = []
    for s in symbols:
        for m in METRICS:
            rows.append({"Symbol": s, "Metric": m,
                         "DelivRatio": deliv.get(s, "") if m == "CASH VOL" else "",
                         "PrevDayRatio": "", "PrevLastHrRatio": ""})
    return pd.DataFrame(rows)


def main():
    now = _now()
    if now.weekday() >= 5:
        print("weekend"); return
    hm = now.hour * 60 + now.minute
    if hm < 9 * 60 + 18 or hm > 15 * 60 + 40:
        print("outside 9:18-15:40 IST"); return

    day = now.strftime("%Y-%m-%d")
    col = f"{now.hour:02d}:{(now.minute // 10) * 10:02d}"   # snap to 10-min

    syms = universe()
    print(f"universe {len(syms)}")

    cash = cash_data(syms);            print(f"  cash    {len(cash)}")
    fut  = fetch_oi_spurts();          print(f"  futures {len(fut)}")
    opt  = option_data(syms);          print(f"  options {len(opt)}")
    deliv = delivery_ratio();          print(f"  deliv   {len(deliv)}")

    df = load_or_init(day, syms, deliv)
    key = {(r.Symbol, r.Metric): i for i, r in enumerate(df.itertuples())}

    def put(sym, metric, value):
        i = key.get((sym, metric))
        if i is not None:
            df.at[i, col] = value

    if col not in df.columns:
        df[col] = ""

    for s in syms:
        c = cash.get(s)
        if c and c["yday"] > 0:
            put(s, "CASH VOL", round(c["today"] / c["yday"], 3))
            if not str(df.at[key[(s, "CASH VOL")], "PrevDayRatio"]).strip():
                if c["prev"] > 0:
                    df.at[key[(s, "CASH VOL")], "PrevDayRatio"] = round(c["yday"] / c["prev"], 3)
                if c["yday_lasthr"] > 0:
                    df.at[key[(s, "CASH VOL")], "PrevLastHrRatio"] = round(
                        c["yday_lasthr"] / c["yday"], 3)
        f = fut.get(s)
        if f:
            if f.get("prev_oi"):
                put(s, "FUT OI", round(f["latest_oi"] / f["prev_oi"], 3))
                if not str(df.at[key[(s, "FUT OI")], "PrevDayRatio"]).strip():
                    df.at[key[(s, "FUT OI")], "PrevDayRatio"] = round(
                        f["latest_oi"] / f["prev_oi"], 3)
            if f.get("volume"):
                put(s, "FUT VOL", int(f["volume"]))
        o = opt.get(s)
        if o:
            put(s, "CALL VOL", o["call_vol"]); put(s, "CALL OI", o["call_oi"])
            put(s, "PUT VOL",  o["put_vol"]);  put(s, "PUT OI",  o["put_oi"])

    df.to_csv(path_for(day), index=False)
    print(f"{col}  wrote {len(df)} rows x {len(df.columns)} cols -> matrix_{day}.csv")


if __name__ == "__main__":
    main()
