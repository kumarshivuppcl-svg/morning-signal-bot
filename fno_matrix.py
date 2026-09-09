# -*- coding: utf-8 -*-
"""
fno_matrix.py  --  the F&O data matrix (user-specified layout, Sep 2026)
=========================================================================
7 rows per stock, one column per 10-minute snapshot. Every value is an
ABSOLUTE number -- ratios are computed in the sheet, not here.

  ROWS per stock       TIME CELLS hold                 UNIT
    PRICE              live spot                       rupees
    CASH VOL           today's cumulative volume       shares
    F&O VOL            today's cumulative volume       contracts (fut+opt)
    F&O OI             current open interest           contracts (fut+opt)
    CALL VOL           today's volume, ATM +/-5        contracts
    CALL OI            current OI, ATM +/-5            contracts
    PUT VOL            today's volume, ATM +/-5        contracts
    PUT OI             current OI, ATM +/-5            contracts

  COLUMNS
    Symbol | Metric | PrevDay | PrevDay2 | PrevLastHr | DelivPct |
    DelivPctPrev | 09:20 | 09:30 | ... | 15:30

    PrevDay       the previous session's figure -- full-day volume, closing
                  OI, or closing price. Denominator for the headline ratio:
                  time_cell / PrevDay   (and for PRICE, the day's % change)
    PrevDay2      the session before that. Averaging the two gives a steadier
                  denominator: 36 of 208 names had the two differing by more
                  than 2x on 2026-09-09, which alone reshuffles a top-15.
    PrevLastHr    previous session's 14:15-15:30 volume     (cash row only)
    DelivPct      previous session's delivery %             (cash row only)
    DelivPctPrev  the session before that                   (cash row only)

Why absolutes: a ratio cannot be un-divided, so storing one throws away both
inputs and hides a bad denominator inside a plausible-looking number. That is
exactly how 72 of 208 names silently ran against the wrong prior session --
yfinance omits whole sessions and iloc[-2] then picks the day before last.
Absolutes make the error visible and let any ratio, including PCR (which a
ratio-of-ratios cannot express at all), be derived in the sheet.

  Sources and units, verified against NSE's bhavcopies on 2026-09-08:
    cash prev-day   NSE sec_bhavdata_full (NOT yfinance -- see nse_cash_prev)
    F&O VOL / OI    oi-spurts, and these are futures PLUS options: RVNL
                    futures 21,367 + options 25,116 = 46,483 = reported OI
    option volume   bhavcopy TtlTradgVol and the chain's totalTradedVolume
                    are BOTH contracts -- directly divisible
    option OI       bhavcopy OpnIntrst is SHARES, the chain's is contracts
    prev option OI  chain openInterest - changeinOpenInterest, exact to the
                    contract against the bhavcopy (RVNL CE 11,817, PE 6,665)

Note for the renderer: cumulative rows only ever rise, so a cell-vs-cell arrow
on them is always up and says nothing. Draw arrows on the derived ratio or on
the per-interval increment instead.
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
STRIKES  = 5          # ATM +/- 5, inclusive both sides = 11 strikes
BATCH    = 25
WORKERS  = 5          # parallel option-chain fetches (NSE-friendly)
_IDX     = {"NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"}
# Cells hold ABSOLUTE numbers, not ratios: a ratio cannot be un-divided, and a
# wrong denominator is invisible inside one (72/208 names silently used the
# wrong prior session before this). Yesterday's figures sit in REF so every
# ratio -- plus PCR and anything else -- is a local division in the sheet.
#
# The two F&O rows are TOTALS (futures + options). Verified 2026-09-08 against
# the bhavcopy: RVNL futures 21,367 + options 25,116 = 46,483, exactly the
# figure NSE's oi-spurts feed reports. They are not futures-only.
# PRICE leads each block: OI rising means opposite things depending on which
# way price is going, so a buildup cannot be read without it.
METRICS  = ["PRICE", "CASH VOL", "F&O VOL", "F&O OI",
            "CALL VOL", "CALL OI", "PUT VOL", "PUT OI"]
REF      = ["PrevDay", "PrevDay2", "PrevLastHr", "DelivPct", "DelivPctPrev",
            "Open"]


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
def cash_data(symbols, d1=None):
    """{sym: {'today': cumulative shares, 'lasthr': d1's 14:15-15:30 shares}}

    Yesterday's FULL-day volume deliberately does NOT come from here. yfinance
    silently omits whole sessions -- 72 of 208 F&O names had no 2026-09-07 bar
    -- and positional indexing (iloc[-2]) then picks the session before last
    with no error. NSE's own bhavcopy supplies it instead; see nse_cash_prev().
    `d1` is the real previous trading date, so the last-hour figure is matched
    BY DATE and simply stays blank when yfinance lacks that session."""
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
            rec = {"today": 0.0, "lasthr": 0.0, "open": 0.0}
            # Today's running total: the daily bar is the exchange's own figure
            # and is more complete than summing 5-minute bars (RVNL: 1,901,031
            # vs 1,791,416). Match it by date, never by position.
            try:
                if dl is not None:
                    d = dl[x + ".NS"] if isinstance(dl.columns, pd.MultiIndex) else dl
                    d = d.dropna(subset=["Close"])
                    for ts, row in d.iterrows():
                        if str(ts)[:10] == today:
                            rec["today"] = float(row["Volume"])
                            # The ONLY source for Open. Checked against NSE's
                            # own bhavcopy for 2026-09-09: the daily bar's Open
                            # matched OPEN_PRICE exactly on all 208 F&O names.
                            # See the note below on why nothing stands in for
                            # it while it is still absent.
                            rec["open"] = float(row.get("Open", 0) or 0)
                            break
            except Exception:
                pass
            try:
                if m5 is not None:
                    s = m5[x + ".NS"] if isinstance(m5.columns, pd.MultiIndex) else m5
                    s = s.reset_index()
                    dtc = "Datetime" if "Datetime" in s.columns else s.columns[0]
                    s["dt"] = pd.to_datetime(s[dtc], utc=True).dt.tz_convert(IST)
                    s["d"]  = s["dt"].dt.strftime("%Y-%m-%d")
                    s["hm"] = s["dt"].dt.strftime("%H:%M")
                    s = s.dropna(subset=["Close"]).sort_values("dt")
                    if rec["today"] <= 0:
                        rec["today"] = float(s[s.d == today]["Volume"].fillna(0).sum())
                    # No fallback for Open. The first 5-minute bar starts at the
                    # continuous session and misses the 09:00-09:15 pre-open
                    # auction that sets the opening price: across all 208 F&O
                    # names on 2026-09-09 it matched NSE's OPEN_PRICE on only
                    # 22, median error 0.13% and worst 1.2% (TECHM 1512.40
                    # against a true 1531.00). A wrong GAP% reads as a gap that
                    # did not happen, so Open stays BLANK until the daily bar
                    # arrives -- GAP% and OPEN% are then simply absent for the
                    # first snapshot or two rather than quietly wrong.
                    if d1:
                        yd = s[s.d == d1]
                        if not yd.empty:
                            rec["lasthr"] = float(
                                yd[yd.hm >= "14:15"]["Volume"].fillna(0).sum())
            except Exception:
                pass
            if rec["today"] > 0 or rec["lasthr"] > 0:
                out[x] = rec
    return out


# ------------------------------------------------------------- delivery -----
def nse_cash_prev():
    """The last two COMPLETED cash sessions, straight from NSE's bhavcopy --
    the authoritative source for both volume and delivery, with no missing
    sessions. Returns (sessions, dates), newest first, each session
    {sym: {"vol": shares, "deliv": delivery %}}."""
    from curl_cffi import requests as cffi
    s = cffi.Session(impersonate="chrome")

    def one(d):
        url = ("https://nsearchives.nseindia.com/products/content/"
               f"sec_bhavdata_full_{d.strftime('%d%m%Y')}.csv")
        try:
            r = s.get(url, timeout=20)
            if r.status_code != 200 or len(r.content) < 500:
                return {}
            out = {}
            for x in csv.DictReader(r.text.splitlines()):
                k = {kk.strip(): vv for kk, vv in x.items() if kk}
                if k.get("SERIES", "").strip() != "EQ":
                    continue
                try:
                    vol = float(k.get("TTL_TRD_QNTY", 0) or 0)
                except Exception:
                    continue
                try:                       # DELIV_PER is '-' for some scrips
                    dp = float(k.get("DELIV_PER", 0) or 0)
                except Exception:
                    dp = 0.0
                try:
                    cl = float(k.get("CLOSE_PRICE", 0) or 0)
                except Exception:
                    cl = 0.0
                out[k["SYMBOL"].strip()] = {"vol": vol, "deliv": dp, "close": cl}
            return out
        except Exception:
            return {}

    d, got, dates = _now().date(), [], []
    for _ in range(12):
        d -= timedelta(days=1)
        if d.weekday() >= 5:
            continue
        r = one(d)
        if r:
            got.append(r)
            dates.append(d.strftime("%Y-%m-%d"))
        if len(got) == 2:
            break
    return got, dates


# -------------------------------------------------------------- options -----
def _chain_session():
    from curl_cffi import requests as cffi
    s = cffi.Session(impersonate="chrome")
    s.get("https://www.nseindia.com/option-chain", timeout=15)
    time.sleep(0.5)
    return s


_H = {"Referer": "https://www.nseindia.com/option-chain",
      "Accept": "application/json, text/plain, */*"}

_MON = {"Jan": "01", "Feb": "02", "Mar": "03", "Apr": "04", "May": "05",
        "Jun": "06", "Jul": "07", "Aug": "08", "Sep": "09", "Oct": "10",
        "Nov": "11", "Dec": "12"}


def _iso_expiry(e):
    """'29-Sep-2026' -> '2026-09-29', matching the bhavcopy's XpryDt."""
    try:
        dd, mon, yy = str(e).strip().split("-")
        return f"{yy}-{_MON[mon[:3].title()]}-{int(dd):02d}"
    except Exception:
        return ""


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
            # Inclusive on BOTH sides: STRIKES below + ATM + STRIKES above.
            # The slice end is exclusive, hence the +1 -- without it the window
            # was 5 below / ATM / 4 above, i.e. quietly skewed to the downside.
            sel = rows[max(0, atm - STRIKES): atm + STRIKES + 1]
            cv = co = pv = po = 0
            c_prev = p_prev = 0
            sel_ks = []
            for z in sel:
                sel_ks.append(float(z.get("strikePrice", 0) or 0))
                ce, pe = z.get("CE") or {}, z.get("PE") or {}
                _coi = int(float(ce.get("openInterest", 0) or 0))
                _poi = int(float(pe.get("openInterest", 0) or 0))
                cv += int(float(ce.get("totalTradedVolume", 0) or 0))
                pv += int(float(pe.get("totalTradedVolume", 0) or 0))
                co += _coi
                po += _poi
                # yesterday's OI = today's OI minus the change since yesterday
                c_prev += _coi - int(float(ce.get("changeinOpenInterest", 0) or 0))
                p_prev += _poi - int(float(pe.get("changeinOpenInterest", 0) or 0))
            # `expiry` + `strikes` let the caller pull yesterday's volume for
            # EXACTLY these contracts, so both sides of the ratio cover the
            # same strike band even when the underlying has moved hard.
            return sym, {"call_vol": cv, "call_oi": co,
                         "put_vol": pv, "put_oi": po,
                         "call_prev_oi": c_prev, "put_prev_oi": p_prev,
                         "expiry": _iso_expiry(exps[0]), "strikes": sel_ks}
        except Exception:
            return sym, None

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for sym, d in ex.map(one, enumerate(symbols)):
            if d:
                out[sym] = d
    return out


# ------------------------------------------------------------- assemble -----
def prev_fno_volumes(days=1):
    """Completed F&O sessions from NSE's derivatives bhavcopy, kept at
    per-contract granularity so the caller can sum exactly the strikes it
    measured today (see prev_opt_vol).

    Returns (sessions, dates), newest first, each session
        {sym: {"ce": {(expiry_iso, strike): vol},
               "pe": {(expiry_iso, strike): vol},
               "spot":    that day's underlying price,
               "tot_vol": futures+options contracts traded,
               "tot_oi":  futures+options open interest, contracts}}"""
    import io as _io, zipfile as _zip
    from curl_cffi import requests as cffi
    sess = cffi.Session(impersonate="chrome")

    def one(d):
        url = ("https://nsearchives.nseindia.com/content/fo/"
               f"BhavCopy_NSE_FO_0_0_0_{d.strftime('%Y%m%d')}_F_0000.csv.zip")
        try:
            r = sess.get(url, timeout=30)
        except Exception:
            return None
        if r.status_code != 200 or len(r.content) < 5000:
            return None
        try:
            z = _zip.ZipFile(_io.BytesIO(r.content))
            rows = list(csv.DictReader(
                _io.TextIOWrapper(z.open(z.namelist()[0]), encoding="utf-8")))
        except Exception:
            return None

        ce, pe, spot, tv, toi, lot = {}, {}, {}, {}, {}, {}
        ceo, peo = {}, {}          # per-contract OI, shares -> contracts below
        for x in rows:
            tp = (x.get("FinInstrmTp") or "").strip()
            if tp not in ("STF", "STO"):
                continue
            sym = (x.get("TckrSymb") or "").strip()
            try:
                vol = float(x.get("TtlTradgVol", 0) or 0)
                oi  = float(x.get("OpnIntrst", 0) or 0)
                lq  = float(x.get("NewBrdLotQty", 0) or 0)
            except Exception:
                continue
            # Totals span futures AND options, matching what oi-spurts reports.
            tv[sym]  = tv.get(sym, 0.0) + vol
            toi[sym] = toi.get(sym, 0.0) + oi       # shares; -> contracts below
            if lq > 0:
                lot[sym] = lq
            if tp != "STO":
                continue
            try:
                k = float(x.get("StrkPric", 0) or 0)
                u = float(x.get("UndrlygPric", 0) or 0)
            except Exception:
                continue
            if u > 0:
                spot.setdefault(sym, u)
            ot = (x.get("OptnTp") or "").strip()
            if ot == "CE":
                tgt, tgo = ce, ceo
            elif ot == "PE":
                tgt, tgo = pe, peo
            else:
                continue
            kk = (x.get("XpryDt", ""), k)
            m  = tgt.setdefault(sym, {})
            m[kk] = m.get(kk, 0.0) + vol
            n  = tgo.setdefault(sym, {})
            n[kk] = n.get(kk, 0.0) + oi

        out = {}
        for sym in set(list(tv) + list(ce) + list(pe)):
            L = lot.get(sym, 0) or 1
            # Bhavcopy OI is in SHARES while the option chain reports CONTRACTS,
            # so divide here to keep both sides of the ratio in one unit.
            out[sym] = {"ce": ce.get(sym, {}), "pe": pe.get(sym, {}),
                        "ceoi": {k: v / L for k, v in ceo.get(sym, {}).items()},
                        "peoi": {k: v / L for k, v in peo.get(sym, {}).items()},
                        "spot": spot.get(sym, 0.0),
                        "tot_vol": tv.get(sym, 0.0),
                        "tot_oi":  toi.get(sym, 0.0) / L}
        return out

    d, got, dates = _now().date(), [], []
    for _ in range(12):
        d -= timedelta(days=1)
        if d.weekday() >= 5:
            continue
        r = one(d)
        if r:
            got.append(r)
            dates.append(d.strftime("%Y-%m-%d"))
        if len(got) >= days:
            break
    if got:
        print(f"  prev F&O bhavcopy {', '.join(dates)}: "
              f"{len(got[0])} symbols (per-contract)")
    return got, dates


THIN = 0.25   # contract-matched base below this share of the moneyness-matched
              # base means the strike band has moved into yesterday's dormant
              # territory; dividing by it produces a huge, meaningless ratio.


def _band_totals(pf, expiry, strikes, ck="ce", pk="pe"):
    cem, pem = pf.get(ck, {}), pf.get(pk, {})
    cv = pv = 0.0
    seen = 0
    for k in strikes:
        kk = (expiry, k)
        if kk in cem or kk in pem:
            seen += 1
        cv += cem.get(kk, 0.0)
        pv += pem.get(kk, 0.0)
    return cv, pv, (seen / len(strikes) if strikes else 0.0)


def prev_opt_vol(pf, expiry, strikes, ck="ce", pk="pe"):
    """A prior session's CE/PE figure for the SAME expiry and the SAME strikes
    we measured today, so a stock that has moved is not compared against a
    different price band. ck/pk select the quantity: "ce"/"pe" for volume,
    "ceoi"/"peoi" for open interest.

    Guard: when those exact contracts were nearly dormant yesterday (a big
    mover's new band sat far OTM), the contract-matched base collapses toward
    zero and the ratio explodes on noise. In that case fall back to yesterday's
    own ATM band -- same moneyness rather than same strike -- which is the
    honest comparison when the strikes themselves have no history.

    Returns (call_vol, put_vol, coverage, matched) where `matched` is True when
    the strict contract-matched base was used."""
    if not pf or not expiry or not strikes:
        return 0.0, 0.0, 0.0, False
    cv, pv, cover = _band_totals(pf, expiry, strikes, ck, pk)

    ks = sorted({k for (e, k) in pf.get(ck, {}) if e == expiry} |
                {k for (e, k) in pf.get(pk, {}) if e == expiry})
    yspot = pf.get("spot", 0.0)
    if not ks or yspot <= 0:
        return cv, pv, cover, True
    a = min(range(len(ks)), key=lambda i: abs(ks[i] - yspot))
    yband = ks[max(0, a - STRIKES): a + STRIKES + 1]
    ycv, ypv, _ = _band_totals(pf, expiry, yband, ck, pk)

    if (ycv > 0 and cv < THIN * ycv) or (ypv > 0 and pv < THIN * ypv):
        return ycv, ypv, cover, False
    return cv, pv, cover, True


def _blank(v):
    """True when a cell is genuinely empty (handles pandas NaN -> 'nan')."""
    t = str(v).strip().lower()
    return t in ("", "nan", "none")


def path_for(day):
    return os.path.join(DATA_D, f"matrix_{day}.csv")


def load_or_init(day, symbols):
    p = path_for(day)
    if os.path.exists(p):
        d = pd.read_csv(p, dtype=object)
        # A file written by the ratio-era code has different reference columns
        # AND ratio values in its time cells. Appending absolutes to it would
        # leave one row holding both, which is worse than losing the morning:
        # start the day again rather than mix the two.
        # "PrevDay" marks the absolute-era format. Testing for the FULL set of
        # REF columns would mean that merely adding one (Open) looked like the
        # old ratio format and threw the day away.
        if "PrevDay" in d.columns:
            for c in REF:
                if c not in d.columns:
                    d[c] = ""
            # A metric added since the file was created (PRICE) is appended
            # rather than triggering a rebuild, so the day's snapshots survive.
            have = set(zip(d["Symbol"], d["Metric"]))
            gap  = [{"Symbol": s, "Metric": m}
                    for s in symbols for m in METRICS if (s, m) not in have]
            if gap:
                d = pd.concat([d, pd.DataFrame(gap)], ignore_index=True)
                order = {m: i for i, m in enumerate(METRICS)}
                d["_o"] = d["Metric"].map(order).fillna(len(order))
                d = (d.sort_values(["Symbol", "_o"], kind="stable")
                       .drop(columns="_o").reset_index(drop=True))
                print(f"  added {len(gap)} rows for new metrics")
            return d.astype(object)
        print(f"  {os.path.basename(p)} is in the old ratio format -- "
              f"rebuilding as absolutes")
    rows = []
    for s in symbols:
        for m in METRICS:
            r = {"Symbol": s, "Metric": m}
            r.update({c: "" for c in REF})
            rows.append(r)
    return pd.DataFrame(rows).astype(object)


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

    cashp, cdates = nse_cash_prev()
    print(f"  cash bhavcopy {', '.join(cdates) or 'none'}")
    d1 = cdates[0] if cdates else None

    cash = cash_data(syms, d1);        print(f"  cash    {len(cash)}")
    fut  = fetch_oi_spurts();          print(f"  futures {len(fut)}")
    opt  = option_data(syms);          print(f"  options {len(opt)}")
    fo, _fdates = prev_fno_volumes(days=2)

    p1 = cashp[0] if len(cashp) > 0 else {}
    p2 = cashp[1] if len(cashp) > 1 else {}
    f1 = fo[0]    if len(fo)    > 0 else {}
    f2 = fo[1]    if len(fo)    > 1 else {}

    df = load_or_init(day, syms)
    key = {(r.Symbol, r.Metric): i for i, r in enumerate(df.itertuples())}

    def put(sym, metric, value):
        i = key.get((sym, metric))
        if i is not None:
            df.at[i, col] = value

    def ref(sym, metric, column, value, force=False):
        """Reference columns hold prior-session figures.

        Most are properties of a finished session -- closing price, full-day
        volume, delivery -- so they are written once and left alone.

        The four option rows are the exception and pass force=True. Their
        baseline is summed over the ATM band measured in THIS snapshot, and
        spot moves during the day. Writing it once would anchor the
        denominator to whichever band happened to be current at the first
        snapshot while the numerator kept following spot to new strikes --
        reintroducing intraday the very band mismatch that was fixed
        day-over-day. Recomputing keeps both sides on the same contracts."""
        i = key.get((sym, metric))
        if i is not None and (force or _blank(df.at[i, column])):
            df.at[i, column] = value

    for c in REF:
        if c not in df.columns:
            df[c] = ""
        df[c] = df[c].astype(object)
    if col not in df.columns:
        df[col] = ""
    df[col] = df[col].astype(object)

    for s in syms:
        # ---- cash: today's running total, yesterday's from NSE not yfinance
        c = cash.get(s)
        if c:
            if c["today"] > 0:
                put(s, "CASH VOL", int(c["today"]))
            if c["lasthr"] > 0:
                ref(s, "CASH VOL", "PrevLastHr", int(c["lasthr"]))
            # Only ever written from the daily bar, so the cell stays blank
            # until that exists rather than holding an approximation. force
            # keeps it tracking the source if the bar is later revised.
            if c.get("open", 0) > 0:
                ref(s, "PRICE", "Open", round(c["open"], 2), force=True)
        if s in p1:
            ref(s, "CASH VOL", "PrevDay",      int(p1[s]["vol"]))
            ref(s, "CASH VOL", "DelivPct",     p1[s]["deliv"])
            if p1[s].get("close"):
                ref(s, "PRICE", "PrevDay", p1[s]["close"])
        if s in p2:
            ref(s, "CASH VOL", "PrevDay2",     int(p2[s]["vol"]))
            ref(s, "CASH VOL", "DelivPctPrev", p2[s]["deliv"])
            if p2[s].get("close"):
                ref(s, "PRICE", "PrevDay2", p2[s]["close"])

        # ---- futures+options totals
        f = fut.get(s)
        if f:
            if f.get("spot"):
                put(s, "PRICE", f["spot"])
            if f.get("volume"):
                put(s, "F&O VOL", int(f["volume"]))
            if f.get("latest_oi"):
                put(s, "F&O OI", int(f["latest_oi"]))
            if f.get("prev_oi"):
                ref(s, "F&O OI", "PrevDay", int(f["prev_oi"]))
        if s in f1:
            ref(s, "F&O VOL", "PrevDay",  int(f1[s]["tot_vol"]))
        if s in f2:
            ref(s, "F&O VOL", "PrevDay2", int(f2[s]["tot_vol"]))
            ref(s, "F&O OI",  "PrevDay2", int(f2[s]["tot_oi"]))

        # ---- options, ATM +/-STRIKES of the nearest expiry
        o = opt.get(s)
        if o:
            put(s, "CALL VOL", o["call_vol"])
            put(s, "PUT VOL",  o["put_vol"])
            put(s, "CALL OI",  o["call_oi"])
            put(s, "PUT OI",   o["put_oi"])
            # Yesterday's OI comes free with the chain: openInterest minus
            # changeinOpenInterest. Verified exact against the bhavcopy.
            if o.get("call_prev_oi"):
                ref(s, "CALL OI", "PrevDay", o["call_prev_oi"], force=True)
            if o.get("put_prev_oi"):
                ref(s, "PUT OI",  "PrevDay", o["put_prev_oi"], force=True)
            # Same expiry, same strikes on both sides, so a stock that has
            # moved is not compared against a different price band.
            xp, ks_ = o.get("expiry"), o.get("strikes")
            b_cv, b_pv, cover, _x = prev_opt_vol(f1.get(s), xp, ks_)
            if b_cv > 0 and cover >= 0.6:
                ref(s, "CALL VOL", "PrevDay", int(b_cv), force=True)
            if b_pv > 0 and cover >= 0.6:
                ref(s, "PUT VOL",  "PrevDay", int(b_pv), force=True)

            # Session before last, same expiry and strikes. The band is two
            # sessions stale here, so the dormant-band fallback matters more.
            c2, p2_, cov2, _x = prev_opt_vol(f2.get(s), xp, ks_)
            if c2 > 0 and cov2 >= 0.6:
                ref(s, "CALL VOL", "PrevDay2", int(c2), force=True)
            if p2_ > 0 and cov2 >= 0.6:
                ref(s, "PUT VOL",  "PrevDay2", int(p2_), force=True)
            co2, po2, cov3, _x = prev_opt_vol(f2.get(s), xp, ks_, "ceoi", "peoi")
            if co2 > 0 and cov3 >= 0.6:
                ref(s, "CALL OI", "PrevDay2", int(co2), force=True)
            if po2 > 0 and cov3 >= 0.6:
                ref(s, "PUT OI",  "PrevDay2", int(po2), force=True)

    df = df[["Symbol", "Metric"] + REF +
            [c for c in df.columns if ":" in str(c)]]
    df.to_csv(path_for(day), index=False)
    print(f"{col}  wrote {len(df)} rows x {len(df.columns)} cols -> matrix_{day}.csv")


if __name__ == "__main__":
    main()
