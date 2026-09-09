# -*- coding: utf-8 -*-
"""
rank_top.py  --  turn the absolute matrix into a ranked opportunity list
=========================================================================
Reads data/matrix_YYYY-MM-DD.csv (absolutes) and writes
data/top15_YYYY-MM-DD.csv, newest snapshot only.

BASELINE
    Every ratio divides by the mean of the two prior sessions, not just the
    last one. On 2026-09-09, 36 of 208 names had PrevDay and PrevDay2 more
    than 2x apart and 11 were more than 3x apart, so a single-day denominator
    is hostage to whether yesterday happened to be quiet -- it swapped three
    names in and out of the top 15 by itself.

COMPOSITE
    Percentile ranks, not raw values, so no column's scale can dominate:

        0.40 * pct(VOL)  +  0.30 * pct(OPT)  +  0.30 * pct(OIC)

    Single columns each miss most of what the others see -- on 2026-09-09 the
    cash-volume and options-vs-cash top-15s shared exactly 1 name, and OI
    build and options-vs-cash shared none. The composite recovers 8-10 names
    from each single-column list.

READING COLUMNS (not scored -- they explain a rank rather than set it)
    PCR     put OI / call OI, an absolute level
    LEV     option heat / cash heat. High = positioning is happening in the
            options, not the cash. Low on a big VOL = block or index flow,
            which ranks high but is usually not an options trade.
    BUILD   price direction x OI direction: the four classic states.
    DLV     delivery % change, prior session vs the one before.
"""
import os, sys, glob
from datetime import datetime, timedelta, timezone

import pandas as pd

IST    = timezone(timedelta(hours=5, minutes=30))
DATA_D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
W_VOL, W_OPT, W_OIC = 0.40, 0.30, 0.30
TOP_N  = 15


def _series(df, metric, column):
    s = df[df.Metric == metric].set_index("Symbol")
    if column not in s.columns:
        return pd.Series(dtype=float)
    return pd.to_numeric(s[column], errors="coerce")


def build(day=None, top_n=TOP_N):
    day = day or datetime.now(IST).strftime("%Y-%m-%d")
    path = os.path.join(DATA_D, f"matrix_{day}.csv")
    if not os.path.exists(path):
        hits = sorted(glob.glob(os.path.join(DATA_D, "matrix_*.csv")))
        if not hits:
            print("no matrix file to rank")
            return None
        path = hits[-1]
        day = os.path.basename(path)[7:17]

    df = pd.read_csv(path, dtype=object)
    tcols = [c for c in df.columns if ":" in str(c)]
    if not tcols:
        print(f"{os.path.basename(path)} has no snapshots yet")
        return None
    now = tcols[-1]

    first = tcols[0]
    g = lambda m, c: _series(df, m, c)
    T = pd.DataFrame({
        "price":  g("PRICE",    now),   "pc1": g("PRICE",    "PrevDay"),
        "open":   g("PRICE",    "Open"),
        "oi0":    g("F&O OI",   first),
        "cash":   g("CASH VOL", now),
        "cp1":    g("CASH VOL", "PrevDay"), "cp2": g("CASH VOL", "PrevDay2"),
        "oi":     g("F&O OI",   now),
        "op1":    g("F&O OI",   "PrevDay"), "op2": g("F&O OI",   "PrevDay2"),
        "cvol":   g("CALL VOL", now),
        "cv1":    g("CALL VOL", "PrevDay"), "cv2": g("CALL VOL", "PrevDay2"),
        "pvol":   g("PUT VOL",  now),
        "pv1":    g("PUT VOL",  "PrevDay"), "pv2": g("PUT VOL",  "PrevDay2"),
        "coi":    g("CALL OI",  now),   "poi": g("PUT OI", now),
        "dlv":    g("CASH VOL", "DelivPct"),
        "dlv2":   g("CASH VOL", "DelivPctPrev"),
    })

    def base(a, b):
        """Mean of the two prior sessions; falls back to whichever exists."""
        m = pd.concat([a, b], axis=1).mean(axis=1, skipna=True)
        return m.where(m > 0)

    T["VOL"] = T.cash / base(T.cp1, T.cp2)
    T["OIC"] = T.oi   / base(T.op1, T.op2)
    T["CV"]  = T.cvol / base(T.cv1, T.cv2)
    T["PV"]  = T.pvol / base(T.pv1, T.pv2)
    T["OPT"] = T[["CV", "PV"]].max(axis=1)

    T = T.dropna(subset=["VOL", "OPT", "OIC"])
    if T.empty:
        print("no rows with a usable two-session baseline yet")
        return None

    pct = lambda s: s.rank(pct=True)
    T["SCORE"] = (W_VOL * pct(T.VOL) + W_OPT * pct(T.OPT) + W_OIC * pct(T.OIC))

    T["PCR"] = (T.poi / T.coi).where(T.coi > 0)
    T["LEV"] = (T.OPT / T.VOL).where(T.VOL > 0)
    T["DLV"] = T.dlv - T.dlv2

    # Three price frames, because one number cannot separate a gap from the
    # session. COFORGE on 2026-09-09: GAP -6.6, OPN +2.3, CHG -4.5 -- down on
    # the day, up since the open, and only the pair says so.
    T["CHG"] = ((T.price / T.pc1  - 1) * 100).where(T.pc1  > 0)
    T["OPN"] = ((T.price / T.open - 1) * 100).where(T.open > 0)
    T["GAP"] = ((T.open  / T.pc1  - 1) * 100).where((T.pc1 > 0) & (T.open > 0))

    def state(chg, oi_up):
        if pd.isna(chg) or oi_up is None:
            return ""
        up = chg > 0
        return ("LONG BUILD"  if up and oi_up else
                "SHORT COVER" if up else
                "SHORT BUILD" if oi_up else "LONG UNWIND")

    # BUILD reads the whole day: OI now against the prior session's close.
    T["BUILD"] = [state(c, (o > 1.005) if pd.notna(o) else None)
                  for c, o in zip(T.CHG, T.OIC)]

    # SESS reads the session alone: price against today's open, OI against the
    # day's FIRST snapshot. It answers the question BUILD cannot -- whether
    # positions are still being added into the move you are watching now, or
    # whether the build happened earlier and the move is just a bounce.
    sess_oi = (T.oi / T.oi0).where(T.oi0 > 0)
    T["SOI"] = sess_oi
    T["SESS"] = [state(c, (o > 1.002) if pd.notna(o) else None)
                 for c, o in zip(T.OPN, sess_oi)]

    out = T.sort_values("SCORE", ascending=False).head(top_n)
    cols = ["SCORE", "VOL", "OPT", "OIC", "GAP", "OPN", "CHG", "SOI",
            "PCR", "LEV", "DLV", "BUILD", "SESS"]
    out = out[cols].round(3)
    out.insert(0, "Rank", range(1, len(out) + 1))
    out.index.name = "Symbol"

    dest = os.path.join(DATA_D, f"top15_{day}.csv")
    out.to_csv(dest)
    print(f"{day} {now}  ->  {os.path.basename(dest)}  ({len(out)} rows, "
          f"ranked from {len(T)} stocks)")
    return out, now, day


if __name__ == "__main__":
    r = build(sys.argv[1] if len(sys.argv) > 1 else None)
    if r is not None:
        out, now, day = r
        print()
        print(f"{'#':<3}{'SYM':<12}{'SCORE':>6}{'VOL':>6}{'OPT':>7}{'OIC':>7}"
              f"{'GAP%':>7}{'OPEN%':>7}{'CHG%':>7}{'sOI':>6}{'PCR':>6}"
              f"{'LEV':>6}  {'BUILD (day)':<12} SESSION")
        for s, x in out.iterrows():
            f = lambda v, w, p=2: (f"{v:>{w}.{p}f}" if pd.notna(v)
                                   else " " * (w - 1) + "-")
            print(f"{int(x.Rank):<3}{s:<12}{f(x.SCORE,6,3)}{f(x.VOL,6)}"
                  f"{f(x.OPT,7)}{f(x.OIC,7,3)}{f(x.GAP,7)}{f(x.OPN,7)}"
                  f"{f(x.CHG,7)}{f(x.SOI,6,3)}{f(x.PCR,6)}{f(x.LEV,6)}"
                  f"  {str(x.BUILD):<12} {x.SESS}")
