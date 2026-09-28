# -*- coding: utf-8 -*-
"""
scorecard.py  --  did the ranking actually predict anything?
=============================================================
Appends every published top-15 to data/scorecard.csv and fills in what those
names went on to do. Without this the system publishes a signal and forgets
it, which is why after three weeks the only way to judge it was to
reconstruct performance by hand from 12 noisy day-pairs.

WHAT IT RECORDS
    one row per (date, symbol), carrying the score and its components, the
    price at signal time, the quoted option spread, and both build labels.
    Forward returns are filled in on later runs as the closes exist:

        r1   next session's return, %
        r3   three sessions on, %
        u1   the F&O universe's mean over the same window  (the benchmark)
        u3
        e1   r1 - u1, the edge that actually matters
        e3

DESIGN NOTES
  * Closes come from NSE's cash bhavcopy, never yfinance, which silently drops
    whole sessions -- 72 of 208 names were missing 2026-09-07.
  * Rewriting a day's row is deliberate: the file is overwritten every
    snapshot, so the row converges on the CLOSING ranking for that day.
  * Forward fill is only attempted for dates strictly before today, so an
    ordinary run does no network work once a day's returns are in.
  * The components are logged alongside the composite on purpose. The
    composite's 0.4/0.3/0.3 weights were a judgement call, never validated,
    and the component rankings barely overlap -- so this lets months of data
    say which part, if any, carries the information.

Read it, do not trust it early: a handful of days cannot establish an edge,
and tuning anything on a short sample fits noise.
"""
import os, sys, csv, glob
from datetime import datetime, timedelta, timezone

import pandas as pd

IST    = timezone(timedelta(hours=5, minutes=30))
DATA_D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
PATH   = os.path.join(DATA_D, "scorecard.csv")

COLS = ["date", "symbol", "rank", "score", "vol", "opt", "oic", "chg", "vwp",
        "csprd", "psprd", "build", "sess", "px",
        "r1", "u1", "e1", "r3", "u3", "e3"]

_closes = {}


def _bhav(day):
    """{sym: close} for one session from NSE's cash bhavcopy; {} if no such
    session. Cached, because the fill loop asks for the same dates often."""
    if day in _closes:
        return _closes[day]
    from curl_cffi import requests as cffi
    y, m, d = day.split("-")
    out = {}
    try:
        r = cffi.Session(impersonate="chrome").get(
            "https://nsearchives.nseindia.com/products/content/"
            f"sec_bhavdata_full_{d}{m}{y}.csv", timeout=25)
        if r.status_code == 200 and len(r.content) > 500:
            for x in csv.DictReader(r.text.splitlines()):
                k = {kk.strip(): vv.strip() for kk, vv in x.items() if kk}
                if k.get("SERIES") == "EQ":
                    try:
                        out[k["SYMBOL"]] = float(k["CLOSE_PRICE"])
                    except Exception:
                        pass
    except Exception:
        pass
    _closes[day] = out
    return out


def _sessions_after(day, n):
    """The next `n` dates that actually traded, found by probing forward."""
    d = datetime.strptime(day, "%Y-%m-%d").date()
    got, tries = [], 0
    while len(got) < n and tries < 12:
        tries += 1
        d += timedelta(days=1)
        if d.weekday() >= 5:
            continue
        s = d.strftime("%Y-%m-%d")
        if _bhav(s):
            got.append(s)
    return got


def _universe(day):
    """That day's F&O names, taken from the matrix we already have on disk so
    the benchmark is the tradeable universe rather than all 2,600 EQ scrips."""
    p = os.path.join(DATA_D, f"matrix_{day}.csv")
    if not os.path.exists(p):
        return []
    try:
        return sorted(pd.read_csv(p, usecols=["Symbol"], dtype=object)
                        .Symbol.unique())
    except Exception:
        return []


def _ret(a, b, sym):
    if sym in a and sym in b and a[sym] > 0:
        return (b[sym] / a[sym] - 1) * 100
    return None


def _mean(vals):
    vals = [v for v in vals if v is not None]
    return sum(vals) / len(vals) if vals else None


def load():
    if os.path.exists(PATH):
        df = pd.read_csv(PATH, dtype=object)
        for c in COLS:
            if c not in df.columns:
                df[c] = ""
        return df[COLS].astype(object)
    return pd.DataFrame(columns=COLS).astype(object)


def record(day, df):
    """Add or refresh one day's ranking rows. No network."""
    p = os.path.join(DATA_D, f"top15_{day}.csv")
    if not os.path.exists(p):
        return df, 0
    top = pd.read_csv(p, dtype=object)
    if "Symbol" not in top.columns:
        return df, 0

    mx = os.path.join(DATA_D, f"matrix_{day}.csv")
    px = {}
    if os.path.exists(mx):
        m = pd.read_csv(mx, dtype=object)
        tc = [c for c in m.columns if ":" in str(c)]
        if tc:
            pr = m[m.Metric == "PRICE"].set_index("Symbol")[tc]
            pr = pr.apply(pd.to_numeric, errors="coerce").ffill(axis=1)
            px = pr.iloc[:, -1].to_dict()

    g = lambda r, k: r.get(k, "") if pd.notna(r.get(k, "")) else ""
    rows = []
    for _, r in top.iterrows():
        sym = r["Symbol"]
        rows.append({
            "date": day, "symbol": sym, "rank": g(r, "Rank"),
            "score": g(r, "SCORE"), "vol": g(r, "VOL"), "opt": g(r, "OPT"),
            "oic": g(r, "OIC"), "chg": g(r, "CHG"), "vwp": g(r, "VWP"),
            "csprd": "", "psprd": "",
            "build": g(r, "BUILD"), "sess": g(r, "SESS"),
            "px": round(px[sym], 2) if sym in px and pd.notna(px[sym]) else "",
            "r1": "", "u1": "", "e1": "", "r3": "", "u3": "", "e3": "",
        })

    # the ATM spreads live in the matrix, not the ranking
    if os.path.exists(mx):
        m = pd.read_csv(mx, dtype=object)
        tc = [c for c in m.columns if ":" in str(c)]
        for lbl, key in (("CALL SPRD", "csprd"), ("PUT SPRD", "psprd")):
            sub = m[m.Metric == lbl]
            if sub.empty or not tc:
                continue
            v = (sub.set_index("Symbol")[tc]
                    .apply(pd.to_numeric, errors="coerce")
                    .ffill(axis=1).iloc[:, -1]).to_dict()
            for row in rows:
                if row["symbol"] in v and pd.notna(v[row["symbol"]]):
                    row[key] = v[row["symbol"]]

    new = pd.DataFrame(rows).astype(object)
    keep = df[~((df.date == day))] if len(df) else df
    prior = df[df.date == day] if len(df) else pd.DataFrame(columns=COLS)
    # keep any forward returns already computed for this day
    if len(prior):
        done = prior.set_index("symbol")
        for i, row in new.iterrows():
            if row["symbol"] in done.index:
                for c in ("r1", "u1", "e1", "r3", "u3", "e3"):
                    val = done.loc[row["symbol"], c]
                    if isinstance(val, pd.Series):
                        val = val.iloc[0]
                    new.at[i, c] = val
    out = pd.concat([keep, new], ignore_index=True) if len(keep) else new
    return out.astype(object), len(new)


def fill(df):
    """Fill forward returns wherever the later sessions now exist."""
    if not len(df):
        return df, 0
    today = datetime.now(IST).strftime("%Y-%m-%d")
    filled = 0
    for day in sorted(df.date.unique()):
        if day >= today:
            continue                     # the future has not happened yet
        sub = df[df.date == day]
        need1 = sub.r1.apply(lambda v: str(v).strip() in ("", "nan"))
        need3 = sub.r3.apply(lambda v: str(v).strip() in ("", "nan"))
        if not need1.any() and not need3.any():
            continue
        nxt = _sessions_after(day, 3)
        if not nxt:
            continue
        c0 = _bhav(day)
        if not c0:
            continue
        uni = _universe(day)
        for horizon, col_r, col_u, col_e in ((1, "r1", "u1", "e1"),
                                             (3, "r3", "u3", "e3")):
            if len(nxt) < horizon:
                continue
            c1 = _bhav(nxt[horizon - 1])
            if not c1:
                continue
            ub = _mean([_ret(c0, c1, s) for s in uni]) if uni else None
            for i in sub.index:
                if str(df.at[i, col_r]).strip() not in ("", "nan"):
                    continue
                r = _ret(c0, c1, df.at[i, "symbol"])
                if r is None:
                    continue
                df.at[i, col_r] = round(r, 3)
                if ub is not None:
                    df.at[i, col_u] = round(ub, 3)
                    df.at[i, col_e] = round(r - ub, 3)
                filled += 1
    return df, filled


def summary(df):
    d = df.copy()
    for c in ("e1", "e3", "r1", "u1"):
        d[c] = pd.to_numeric(d[c], errors="coerce")
    done = d.dropna(subset=["e1"])
    if done.empty:
        print("  no completed forward returns yet")
        return
    daily = done.groupby("date")["e1"].mean()
    n = len(daily)
    print(f"  completed days {n}   ranked observations {len(done)}")
    print(f"  mean 1-day edge {daily.mean():+.3f}%   median {daily.median():+.3f}%")
    if n > 2:
        se = daily.std() / (n ** 0.5)
        t = daily.mean() / se if se else float("nan")
        print(f"  se {se:.3f}   t = {t:+.2f}   "
              f"({'significant' if abs(t) > 2.2 else 'NOT significant'} at 5%, "
              f"{n-1} df)")
    print(f"  days the top-15 beat the universe: {(daily > 0).sum()}/{n}")
    sp = pd.to_numeric(done["csprd"], errors="coerce").dropna()
    if len(sp):
        print(f"  median ATM call spread {sp.median():.2f}%  "
              f"-- an edge must clear this to be tradeable in options")


def main(day=None):
    os.makedirs(DATA_D, exist_ok=True)
    day = day or datetime.now(IST).strftime("%Y-%m-%d")
    df = load()
    df, added = record(day, df)
    df, filled = fill(df)
    df = df.sort_values(["date", "rank"], kind="stable")
    df.to_csv(PATH, index=False)
    print(f"scorecard: {len(df)} rows  (+{added} for {day}, {filled} returns filled)")
    summary(df)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
