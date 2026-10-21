import { useState, useEffect, useMemo, useRef } from "react";
import { db } from "./firebase";
import { collection, query, where, orderBy, limit, startAfter, getDocs, deleteDoc, doc, setDoc } from "firebase/firestore";
import { useAuth } from "./AuthContext";

const STAT_META = [
    { key: "new",           label: "Нове",             color: "#888",    bg: "#f5f5f5"  },
    { key: "plan_ready",    label: "План готовий",      color: "#5a7a2a", bg: "#eef5e4"  },
    { key: "plan_approved", label: "План затверджено",  color: "#1a5a8a", bg: "#e4f0ff"  },
    { key: "writing",       label: "В роботі",          color: "#2a7a6a", bg: "#e4f5f2"  },
    { key: "sources",       label: "Джерела",           color: "#8a5a1a", bg: "#fff3e0"  },
    { key: "done",          label: "Готово",            color: "#1a6a1a", bg: "#e4ffe4"  },
];

const DATE_RANGES = [
    { key: "1",   label: "1 день",   days: 1   },
    { key: "2",   label: "2 дні",    days: 2   },
    { key: "7",   label: "7 днів",   days: 7   },
    { key: "30",  label: "Місяць",   days: 30  },
    { key: "90",  label: "3 місяці", days: 90  },
    { key: "all", label: "Весь час", days: null },
];

function getStatStatus(o) {
    const s = o.status || "new";
    if (o.mode === "small") {
        if (o.stage === "sources") return "sources";
        return s;
    }
    if (s !== "done" && o.stage === "sources") return "sources";
    return s;
}

function UserStatsModal({ orders, onClose }) {
    const todayStr = new Date().toISOString().slice(0, 10);

    const todayCount = useMemo(() =>
        orders.filter(o => o.createdAt?.slice(0, 10) === todayStr).length,
    [orders, todayStr]);

    const overall = useMemo(() => {
        const c = { total: orders.length };
        STAT_META.forEach(s => { c[s.key] = 0; });
        orders.forEach(o => { const s = getStatStatus(o); if (c[s] !== undefined) c[s]++; });
        return c;
    }, [orders]);

    return (
        <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 1000, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "32px 16px", overflowY: "auto" }}>
            <div onClick={e => e.stopPropagation()} style={{ background: "#f5f2eb", borderRadius: 14, width: "100%", maxWidth: 580, fontFamily: "'Spectral',Georgia,serif", boxShadow: "0 12px 60px rgba(0,0,0,0.3)" }}>

                <div style={{ background: "#1a1a14", borderRadius: "14px 14px 0 0", padding: "16px 24px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ color: "#e8ff47", fontFamily: "'Spectral SC',serif", fontSize: 15, letterSpacing: 3 }}>МОЇ РЕЗУЛЬТАТИ</div>
                    <button onClick={onClose} style={{ background: "none", border: "none", color: "#888", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>✕</button>
                </div>

                <div style={{ padding: 20 }}>
                    {/* Сьогодні + Всього */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
                        <div style={{ background: "#1a1a14", borderRadius: 12, padding: "20px 22px" }}>
                            <div style={{ fontSize: 11, color: "#666", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>Сьогодні</div>
                            <div style={{ fontSize: 42, fontWeight: 700, color: "#e8ff47", lineHeight: 1 }}>{todayCount}</div>
                            <div style={{ fontSize: 11, color: "#555", marginTop: 6 }}>замовлень</div>
                        </div>
                        <div style={{ background: "#fff", borderRadius: 12, padding: "20px 22px", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
                            <div style={{ fontSize: 11, color: "#aaa", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>Всього</div>
                            <div style={{ fontSize: 42, fontWeight: 700, color: "#1a1a14", lineHeight: 1 }}>{overall.total}</div>
                            <div style={{ fontSize: 11, color: "#aaa", marginTop: 6 }}>за весь час</div>
                        </div>
                    </div>

                    {/* По статусах */}
                    <div style={{ background: "#fff", borderRadius: 10, padding: "14px 18px", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
                        <div style={{ fontSize: 12, color: "#aaa", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>По статусах</div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 10 }}>
                            {STAT_META.map(s => (
                                <div key={s.key} style={{ padding: "10px 12px", borderRadius: 10, background: s.bg, border: `1.5px solid ${s.color}22` }}>
                                    <div style={{ fontSize: 24, fontWeight: 700, color: s.color, lineHeight: 1 }}>{overall[s.key]}</div>
                                    <div style={{ fontSize: 10, color: s.color, opacity: 0.8, marginTop: 4 }}>{s.label}</div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function AdminStatsModal({ onClose }) {
    const [allOrders, setAllOrders] = useState([]);
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [customFrom, setCustomFrom] = useState("");
    const [customTo, setCustomTo] = useState("");

    useEffect(() => {
        const load = async () => {
            const [ordersSnap, usersSnap] = await Promise.all([
                getDocs(collection(db, "orders")),
                getDocs(collection(db, "users")),
            ]);
            setAllOrders(ordersSnap.docs.map(d => ({ id: d.id, ...d.data() })));
            setUsers(usersSnap.docs.map(d => ({ id: d.id, ...d.data() })));
            setLoading(false);
        };
        load();
    }, []);

    const orders = useMemo(() => {
        if (!customFrom && !customTo) return allOrders;
        const from = customFrom ? new Date(customFrom + "T00:00:00") : null;
        const to = customTo ? new Date(customTo + "T23:59:59") : null;
        return allOrders.filter(o => {
            if (!o.createdAt) return false;
            const d = new Date(o.createdAt);
            if (from && d < from) return false;
            if (to && d > to) return false;
            return true;
        });
    }, [allOrders, customFrom, customTo]);

    const overall = useMemo(() => {
        const c = { total: orders.length };
        STAT_META.forEach(s => { c[s.key] = 0; });
        orders.forEach(o => { const s = getStatStatus(o); if (c[s] !== undefined) c[s]++; });
        return c;
    }, [orders]);

    const byManager = useMemo(() => {
        const userMap = {};
        users.forEach(u => { userMap[u.id] = u; });
        const map = {};
        orders.forEach(o => {
            if (!o.uid) return;
            if (!map[o.uid]) {
                map[o.uid] = { uid: o.uid, total: 0, lastOrder: null };
                STAT_META.forEach(s => { map[o.uid][s.key] = 0; });
            }
            const s = getStatStatus(o);
            if (map[o.uid][s] !== undefined) map[o.uid][s]++;
            map[o.uid].total++;
            if (!map[o.uid].lastOrder || o.createdAt > map[o.uid].lastOrder) map[o.uid].lastOrder = o.createdAt;
        });
        return Object.values(map).map(r => ({ ...r, user: userMap[r.uid] })).sort((a, b) => b.total - a.total);
    }, [orders, users]);

    const fmt = iso => iso ? new Date(iso).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

    return (
        <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 1000, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "32px 16px", overflowY: "auto" }}>
            <div onClick={e => e.stopPropagation()} style={{ background: "#f5f2eb", borderRadius: 14, width: "100%", maxWidth: 900, fontFamily: "'Spectral',Georgia,serif", boxShadow: "0 12px 60px rgba(0,0,0,0.3)" }}>

                {/* Заголовок */}
                <div style={{ background: "#1a1a14", borderRadius: "14px 14px 0 0", padding: "16px 24px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ color: "#e8ff47", fontFamily: "'Spectral SC',serif", fontSize: 15, letterSpacing: 3 }}>СТАТИСТИКА</div>
                    <button onClick={onClose} style={{ background: "none", border: "none", color: "#888", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>✕</button>
                </div>

                <div style={{ padding: 20 }}>
                    {loading ? (
                        <div style={{ padding: 40, textAlign: "center", color: "#888" }}>Завантаження...</div>
                    ) : (<>
                        {/* Фільтр */}
                        <div style={{ background: "#fff", borderRadius: 10, padding: "14px 18px", marginBottom: 16, boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
                            <div style={{ fontSize: 10, color: "#aaa", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 12 }}>Період</div>
                            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                    <span style={{ fontSize: 11, color: "#888" }}>Від</span>
                                    <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} style={{ padding: "5px 8px", border: `1.5px solid ${customFrom ? "#1a1a14" : "#e0ddd4"}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", outline: "none" }} />
                                </div>
                                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                    <span style={{ fontSize: 11, color: "#888" }}>До</span>
                                    <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} style={{ padding: "5px 8px", border: `1.5px solid ${customTo ? "#1a1a14" : "#e0ddd4"}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", outline: "none" }} />
                                </div>
                                {(customFrom || customTo) && (
                                    <button onClick={() => { setCustomFrom(""); setCustomTo(""); }} style={{ padding: "5px 10px", borderRadius: 6, border: "1.5px solid #e0ddd4", background: "transparent", color: "#888", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>Скинути ✕</button>
                                )}
                                {!customFrom && !customTo && <span style={{ fontSize: 11, color: "#bbb" }}>— весь час</span>}
                            </div>
                        </div>

                        {/* Загальна статистика */}
                        <div style={{ background: "#fff", borderRadius: 10, padding: "14px 18px", marginBottom: 16, boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
                            <div style={{ fontSize: 14, fontWeight: 700, color: "#1a1a14", marginBottom: 14 }}>Загальна статистика</div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 10 }}>
                                <div style={{ padding: "12px 14px", borderRadius: 10, background: "#1a1a14" }}>
                                    <div style={{ fontSize: 26, fontWeight: 700, color: "#e8ff47", lineHeight: 1 }}>{overall.total}</div>
                                    <div style={{ fontSize: 11, color: "#aaa", marginTop: 4 }}>Всього</div>
                                </div>
                                {STAT_META.map(s => (
                                    <div key={s.key} style={{ padding: "12px 14px", borderRadius: 10, background: s.bg, border: `1.5px solid ${s.color}22` }}>
                                        <div style={{ fontSize: 26, fontWeight: 700, color: s.color, lineHeight: 1 }}>{overall[s.key]}</div>
                                        <div style={{ fontSize: 10, color: s.color, opacity: 0.8, marginTop: 4 }}>{s.label}</div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* По менеджерам */}
                        <div style={{ background: "#fff", borderRadius: 10, padding: "14px 18px", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
                            <div style={{ fontSize: 14, fontWeight: 700, color: "#1a1a14", marginBottom: 14 }}>По менеджерам</div>
                            {byManager.length === 0 ? (
                                <div style={{ color: "#aaa", fontSize: 13 }}>Немає даних за вибраний період</div>
                            ) : (
                                <div style={{ overflowX: "auto" }}>
                                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                                        <thead>
                                            <tr style={{ borderBottom: "2px solid #f0ece2" }}>
                                                <th style={{ textAlign: "left", padding: "7px 10px", color: "#888", fontWeight: 600, fontSize: 10, letterSpacing: 1, textTransform: "uppercase" }}>Менеджер</th>
                                                <th style={{ textAlign: "center", padding: "7px 8px", color: "#888", fontWeight: 600, fontSize: 10, letterSpacing: 1, textTransform: "uppercase" }}>Всього</th>
                                                {STAT_META.map(s => (
                                                    <th key={s.key} style={{ textAlign: "center", padding: "7px 5px", color: s.color, fontWeight: 600, fontSize: 9, whiteSpace: "nowrap" }}>{s.label}</th>
                                                ))}
                                                <th style={{ textAlign: "center", padding: "7px 8px", color: "#888", fontWeight: 600, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", whiteSpace: "nowrap" }}>Останнє</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {byManager.map((row, i) => (
                                                <tr key={row.uid} style={{ borderBottom: "1px solid #f0ece2", background: i % 2 === 0 ? "transparent" : "#faf8f3" }}>
                                                    <td style={{ padding: "9px 10px" }}>
                                                        <div style={{ fontWeight: 600, color: "#1a1a14", fontSize: 13 }}>{row.user?.name || "—"}</div>
                                                        <div style={{ fontSize: 10, color: "#aaa" }}>{row.user?.email || row.uid}</div>
                                                    </td>
                                                    <td style={{ textAlign: "center", fontWeight: 700, fontSize: 14, color: "#1a1a14" }}>{row.total}</td>
                                                    {STAT_META.map(s => (
                                                        <td key={s.key} style={{ textAlign: "center", padding: "9px 5px" }}>
                                                            {row[s.key] > 0 ? (
                                                                <span style={{ display: "inline-block", minWidth: 22, padding: "2px 7px", borderRadius: 10, background: s.bg, color: s.color, fontWeight: 600, fontSize: 11 }}>{row[s.key]}</span>
                                                            ) : <span style={{ color: "#ddd" }}>—</span>}
                                                        </td>
                                                    ))}
                                                    <td style={{ textAlign: "center", color: "#888", fontSize: 11, whiteSpace: "nowrap" }}>{fmt(row.lastOrder)}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                    </>)}
                </div>
            </div>
        </div>
    );
}

const STATUS_LABELS = {
    new: { label: "Нове", color: "#888", bg: "#f5f5f5", dot: "#ccc" },
    plan_ready: { label: "План готовий", color: "#5a7a2a", bg: "#eef5e4", dot: "#8ac040" },
    plan_approved: { label: "План затверджено", color: "#1a5a8a", bg: "#e4f0ff", dot: "#4a9ade" },
    writing: { label: "В роботі", color: "#2a7a6a", bg: "#e4f5f2", dot: "#3abfa0" },
    sources: { label: "Джерела", color: "#8a5a1a", bg: "#fff3e0", dot: "#e8a050" },
    done: { label: "Готово", color: "#1a6a1a", bg: "#e4ffe4", dot: "#4aba4a" },
    file_corrections: { label: "Правки", color: "#6a3a00", bg: "#fff0e0", dot: "#c47a30" },
};

const MONTH_NAMES = ["Січень","Лютий","Березень","Квітень","Травень","Червень","Липень","Серпень","Вересень","Жовтень","Листопад","Грудень"];

function DeadlinePicker({ dlFrom, dlTo, setDlFrom, setDlTo }) {
    const [calOpen, setCalOpen] = useState(false);
    const [calLeft, setCalLeft] = useState(() => { const n = new Date(); return { y: n.getFullYear(), m: n.getMonth() }; });
    const [picking, setPicking] = useState(null);
    const [calHov, setCalHov] = useState(null);
    const calRef = useRef(null);

    const closeCal = () => { setCalOpen(false); setPicking(null); setCalHov(null); };

    useEffect(() => {
        if (!calOpen) return;
        const h = e => { if (calRef.current && !calRef.current.contains(e.target)) closeCal(); };
        document.addEventListener("mousedown", h);
        return () => document.removeEventListener("mousedown", h);
    }, [calOpen]);

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const sameDay = (a, b) => a && b && a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();

    const monthDays = (y, m) => {
        const startDow = (new Date(y, m, 1).getDay() + 6) % 7;
        const days = [];
        for (let i = 0; i < startDow; i++) days.push({ date: new Date(y, m, 1-startDow+i), cur: false });
        const cnt = new Date(y, m+1, 0).getDate();
        for (let d = 1; d <= cnt; d++) days.push({ date: new Date(y, m, d), cur: true });
        while (days.length % 7 !== 0) days.push({ date: new Date(y, m+1, days.length-cnt-startDow+1), cur: false });
        return days;
    };

    let rFrom = dlFrom, rTo = dlTo;
    if (picking) {
        const end = calHov || null;
        if (end) { rFrom = picking <= end ? picking : end; rTo = picking <= end ? end : picking; }
        else { rFrom = picking; rTo = null; }
    }

    const clickDay = d => {
        const nd = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        if (!picking) { setPicking(nd); }
        else {
            const [a, b] = nd < picking ? [nd, new Date(picking)] : [new Date(picking), nd];
            setDlFrom(a); setDlTo(b); closeCal();
        }
    };

    const presets = [
        { label: "Скинути", fn: () => { setDlFrom(null); setDlTo(null); closeCal(); } },
        { label: "Сьогодні", fn: () => { setDlFrom(new Date(today)); setDlTo(new Date(today)); closeCal(); } },
        { label: "Поточний тиждень", fn: () => {
            const mon = new Date(today); mon.setDate(today.getDate()-(today.getDay()+6)%7);
            const sun = new Date(mon); sun.setDate(mon.getDate()+6);
            setDlFrom(mon); setDlTo(sun); closeCal();
        }},
        { label: "Поточний місяць", fn: () => {
            setDlFrom(new Date(today.getFullYear(), today.getMonth(), 1));
            setDlTo(new Date(today.getFullYear(), today.getMonth()+1, 0));
            closeCal();
        }},
    ];

    const rightM = calLeft.m === 11 ? 0 : calLeft.m+1;
    const rightY = calLeft.m === 11 ? calLeft.y+1 : calLeft.y;
    const NB = { background:"transparent", border:"none", cursor:"pointer", fontSize:16, color:"#888", padding:"2px 5px", lineHeight:1, fontFamily:"inherit" };

    const renderMonth = (y, m) => {
        const days = monthDays(y, m);
        const isSingle = rFrom && rTo && sameDay(rFrom, rTo);
        return (
            <div style={{ width:224 }}>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(7,32px)" }}>
                    {["Пн","Вт","Ср","Чт","Пт","Сб","Нд"].map(l => (
                        <div key={l} style={{ textAlign:"center", fontSize:11, color:"#aaa", fontWeight:600, height:28, lineHeight:"28px" }}>{l}</div>
                    ))}
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(7,32px)" }}>
                    {days.map((cell, i) => {
                        const d = cell.date;
                        const nd = new Date(d.getFullYear(), d.getMonth(), d.getDate());
                        const isStart = sameDay(d, rFrom);
                        const isEnd = rTo && sameDay(d, rTo);
                        const selected = isStart || isEnd;
                        const rangeOn = rFrom && rTo && !isSingle;
                        const inR = rangeOn && !selected && nd > rFrom && nd < rTo;
                        const isT = sameDay(d, today);
                        return (
                            <div key={i} style={{ position:"relative", height:32, display:"flex", alignItems:"center", justifyContent:"center", cursor:cell.cur?"pointer":"default" }}
                                onClick={() => cell.cur && clickDay(d)}
                                onMouseEnter={() => { if (picking && cell.cur) setCalHov(new Date(d.getFullYear(), d.getMonth(), d.getDate())); }}
                                onMouseLeave={() => { if (picking) setCalHov(null); }}>
                                {isStart && rangeOn && <div style={{ position:"absolute", top:4, bottom:4, left:"50%", right:0, background:"#dbeafe", zIndex:0 }} />}
                                {isEnd && rangeOn && <div style={{ position:"absolute", top:4, bottom:4, left:0, right:"50%", background:"#dbeafe", zIndex:0 }} />}
                                {inR && <div style={{ position:"absolute", top:4, bottom:4, left:0, right:0, background:"#dbeafe", zIndex:0 }} />}
                                <div style={{ position:"relative", zIndex:1, width:28, height:28, borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center",
                                    background: selected ? "#1a72e5" : "transparent",
                                    color: !cell.cur ? "#ccc" : selected ? "#fff" : inR ? "#1a4a9a" : "#1a1a14",
                                    fontWeight: isT ? 700 : 400, fontSize:13,
                                    boxShadow: isT && !selected ? "inset 0 0 0 1.5px #1a72e5" : "none",
                                }}>
                                    {d.getDate()}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        );
    };

    const fmtD = d => d ? d.toLocaleDateString("uk-UA", { day:"2-digit", month:"2-digit", year:"numeric" }) : null;

    return (
        <div style={{ marginBottom:12, position:"relative" }} ref={calRef}>
            <div style={{ fontSize:11, color:"#aaa", fontWeight:600, letterSpacing:1, textTransform:"uppercase", marginBottom:4 }}>Дедлайн</div>
            <div onClick={() => calOpen ? closeCal() : setCalOpen(true)}
                style={{ display:"inline-flex", alignItems:"center", gap:8, padding:"7px 14px", border:`1.5px solid ${dlFrom?"#1a1a14":"#d4cfc4"}`, borderRadius:8, background:"#fff", cursor:"pointer", fontSize:13, fontFamily:"'Spectral',serif", color:dlFrom?"#1a1a14":"#aaa", userSelect:"none", minWidth:240 }}>
                <span style={{ fontSize:14 }}>📅</span>
                <span style={{ flex:1 }}>
                    {fmtD(dlFrom) ? (fmtD(dlTo) ? `${fmtD(dlFrom)} — ${fmtD(dlTo)}` : fmtD(dlFrom)) : "Дата від — Дата до"}
                </span>
                {(dlFrom || dlTo) && (
                    <span onClick={e => { e.stopPropagation(); setDlFrom(null); setDlTo(null); }} style={{ color:"#bbb", fontSize:14, cursor:"pointer", lineHeight:1 }}>✕</span>
                )}
            </div>

            {calOpen && (
                <div style={{ position:"absolute", top:"calc(100% + 6px)", left:0, zIndex:1000, background:"#fff", borderRadius:12, boxShadow:"0 8px 40px rgba(0,0,0,0.16)", border:"1px solid #e8e4d8", display:"flex", overflow:"hidden" }}>
                    <div style={{ padding:"16px 0", borderRight:"1px solid #f0ece2", minWidth:160 }}>
                        {presets.map(p => (
                            <div key={p.label} onClick={p.fn}
                                style={{ padding:"9px 20px", fontSize:13, cursor:"pointer", color:"#1a72e5", whiteSpace:"nowrap" }}
                                onMouseEnter={e => e.currentTarget.style.background="#f0f4ff"}
                                onMouseLeave={e => e.currentTarget.style.background="transparent"}>
                                {p.label}
                            </div>
                        ))}
                    </div>
                    <div style={{ padding:"16px 20px", display:"flex", gap:20 }}>
                        <div>
                            <div style={{ display:"flex", alignItems:"center", marginBottom:10 }}>
                                <div>
                                    <button onClick={() => setCalLeft(p => ({y:p.y-1,m:p.m}))} style={NB}>«</button>
                                    <button onClick={() => setCalLeft(p => p.m===0?{y:p.y-1,m:11}:{y:p.y,m:p.m-1})} style={NB}>‹</button>
                                </div>
                                <span style={{ fontSize:14, fontWeight:600, color:"#1a1a14", flex:1, textAlign:"center" }}>{calLeft.y} {MONTH_NAMES[calLeft.m]}</span>
                                <div style={{ width:44 }} />
                            </div>
                            {renderMonth(calLeft.y, calLeft.m)}
                        </div>
                        <div>
                            <div style={{ display:"flex", alignItems:"center", marginBottom:10 }}>
                                <div style={{ width:44 }} />
                                <span style={{ fontSize:14, fontWeight:600, color:"#1a1a14", flex:1, textAlign:"center" }}>{rightY} {MONTH_NAMES[rightM]}</span>
                                <div>
                                    <button onClick={() => setCalLeft(p => p.m===11?{y:p.y+1,m:0}:{y:p.y,m:p.m+1})} style={NB}>›</button>
                                    <button onClick={() => setCalLeft(p => ({y:p.y+1,m:p.m}))} style={NB}>»</button>
                                </div>
                            </div>
                            {renderMonth(rightY, rightM)}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default function Dashboard({ onOpen, onNew, onAdmin, onTraining, onFileCorrections }) {
    const { user, profile, logout } = useAuth();
    const [orders, setOrders] = useState([]);
    const [userMap, setUserMap] = useState({});
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [filterStatus, setFilterStatus] = useState(null); // null = всі
    const [dlFrom, setDlFrom] = useState(null);
    const [dlTo, setDlTo] = useState(null);
    const [sortBy, setSortBy] = useState("updated_desc");
    const [filterManager, setFilterManager] = useState("all");
    const [infoOrder, setInfoOrder] = useState(null); // модалка деталей
    const [showHelp, setShowHelp] = useState(false);
    const [showStats, setShowStats] = useState(false);
    const [showMyStats, setShowMyStats] = useState(false);
    const [transferOrderId, setTransferOrderId] = useState(null);
    const [lastDoc, setLastDoc] = useState(null);
    const [hasMore, setHasMore] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [serverCounts, setServerCounts] = useState(null);
    const [selectedIds, setSelectedIds] = useState(() => new Set());
    const [allOrdersFull, setAllOrdersFull] = useState(null); // для пошуку по всій колекції (адмін)

    const isAdmin = profile?.role === "admin";

    const needsSources = (o) => o.mode === "small"
        ? o.stage === "sources"
        : o.status !== "done" && o.stage === "sources";

    useEffect(() => {
        const computeCounts = (docs) => {
            const c = { all: 0, done: 0, writing: 0, sources: 0, plan_ready: 0, new: 0, archived: 0, corrections: 0, deleted: 0 };
            docs.forEach(o => {
                if (o.deleted) { c.deleted++; return; }
                if (o.archived) { c.archived++; return; }
                c.all++;
                if (o.type === "file_corrections") { c.corrections++; return; }
                const s = o.status || "new";
                if (needsSources(o)) c.sources++;
                else if (s === "done") c.done++;
                else if (s === "writing") c.writing++;
                else if (s === "plan_ready" || s === "plan_approved") c.plan_ready++;
                else c.new++;
            });
            return c;
        };

        const load = async () => {
            setLoading(true);
            setLastDoc(null);
            setHasMore(false);
            setServerCounts(null);
            try {
                if (isAdmin) {
                    const ordersQuery = query(
                        collection(db, "orders"),
                        orderBy("createdAt", "desc"),
                        limit(30)
                    );
                    const [ordersSnap, usersSnap] = await Promise.all([
                        getDocs(ordersQuery),
                        getDocs(collection(db, "users")),
                    ]);
                    const map = {};
                    usersSnap.docs.forEach(d => { map[d.id] = d.data(); });
                    setUserMap(map);
                    const docs = ordersSnap.docs;
                    setLastDoc(docs[docs.length - 1] || null);
                    setHasMore(docs.length === 30);
                    setOrders(docs.map(d => ({
                        id: d.id,
                        ...d.data(),
                        managerName: map[d.data().uid]?.name || d.data().uid || "—",
                    })));

                    // фоновий підрахунок по всій колекції + повний список для пошуку
                    getDocs(collection(db, "orders")).then(allSnap => {
                        const allDocs = allSnap.docs.map(d => ({ id: d.id, ...d.data() }));
                        setServerCounts(computeCounts(allDocs));
                        setAllOrdersFull(allDocs.map(o => ({
                            ...o,
                            managerName: map[o.uid]?.name || o.uid || "—",
                        })));
                    }).catch(() => {});
                } else {
                    const q = query(
                        collection(db, "orders"),
                        where("uid", "==", user.uid)
                    );
                    const snap = await getDocs(q);
                    setOrders(
                        snap.docs
                            .map(d => ({ id: d.id, ...d.data() }))
                            .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
                    );
                }
            } catch (e) {
                console.error(e);
            }
            setLoading(false);
        };
        load();
    }, [user.uid, isAdmin]);

    const loadMore = async () => {
        if (!lastDoc || loadingMore) return;
        setLoadingMore(true);
        try {
            const ordersQuery = query(
                collection(db, "orders"),
                orderBy("createdAt", "desc"),
                startAfter(lastDoc),
                limit(30)
            );
            const snap = await getDocs(ordersQuery);
            const newOrders = snap.docs.map(d => ({
                id: d.id,
                ...d.data(),
                managerName: userMap[d.data().uid]?.name || d.data().uid || "—",
            }));
            setOrders(prev => [...prev, ...newOrders]);
            setLastDoc(snap.docs[snap.docs.length - 1] || lastDoc);
            setHasMore(snap.docs.length === 30);
        } catch (e) {
            console.error(e);
        }
        setLoadingMore(false);
    };

    useEffect(() => {
        if (!transferOrderId) return;
        const close = () => setTransferOrderId(null);
        document.addEventListener("click", close);
        return () => document.removeEventListener("click", close);
    }, [transferOrderId]);

    const moveToTrash = async (id, e) => {
        e.stopPropagation();
        if (!window.confirm("Перемістити в кошик?")) return;
        await setDoc(doc(db, "orders", id), { deleted: true, deletedAt: new Date().toISOString() }, { merge: true });
        setOrders(p => p.map(o => o.id === id ? { ...o, deleted: true } : o));
    };

    const restoreOrder = async (id, e) => {
        e.stopPropagation();
        await setDoc(doc(db, "orders", id), { deleted: false }, { merge: true });
        setOrders(p => p.map(o => o.id === id ? { ...o, deleted: false } : o));
    };

    const permanentDelete = async (id, e) => {
        e.stopPropagation();
        if (!window.confirm("Видалити назавжди? Це незворотна дія!")) return;
        await deleteDoc(doc(db, "orders", id));
        setOrders(p => p.filter(o => o.id !== id));
    };

    const toggleSelect = (id, e) => {
        e.stopPropagation();
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const bulkMoveToTrash = async () => {
        if (!window.confirm(`Перемістити в кошик ${selectedIds.size} замовлень?`)) return;
        const ids = [...selectedIds];
        await Promise.all(ids.map(id => setDoc(doc(db, "orders", id), { deleted: true, deletedAt: new Date().toISOString() }, { merge: true })));
        setOrders(p => p.map(o => selectedIds.has(o.id) ? { ...o, deleted: true } : o));
        setSelectedIds(new Set());
    };

    const bulkRestore = async () => {
        const ids = [...selectedIds];
        await Promise.all(ids.map(id => setDoc(doc(db, "orders", id), { deleted: false }, { merge: true })));
        setOrders(p => p.map(o => selectedIds.has(o.id) ? { ...o, deleted: false } : o));
        setSelectedIds(new Set());
    };

    const bulkPermanentDelete = async () => {
        if (!window.confirm(`Видалити назавжди ${selectedIds.size} замовлень? Це незворотна дія!`)) return;
        const ids = [...selectedIds];
        await Promise.all(ids.map(id => deleteDoc(doc(db, "orders", id))));
        setOrders(p => p.filter(o => !selectedIds.has(o.id)));
        setSelectedIds(new Set());
    };

    const transferOrder = async (orderId, newUid, e) => {
        e.stopPropagation();
        await setDoc(doc(db, "orders", orderId), { uid: newUid }, { merge: true });
        setOrders(p => p.map(o => o.id === orderId
            ? { ...o, uid: newUid, managerName: userMap[newUid]?.name || newUid }
            : o
        ));
        setTransferOrderId(null);
    };

    const archiveOrder = async (id, archive, e) => {
        e.stopPropagation();
        await setDoc(doc(db, "orders", id), { archived: archive }, { merge: true });
        setOrders(p => p.map(o => o.id === id ? { ...o, archived: archive } : o));
    };

    // Пагінований запит (orders) містить лише перші 30 замовлень адміна.
    // Щойно активний фільтр за статусом або пошук — треба дивитись у весь
    // фоново завантажений список (allOrdersFull), інакше фільтр працює лише
    // в межах цих 30 і може показувати "порожньо" при ненульовому лічильнику.
    const usingFullSet = isAdmin && (!!search.trim() || !!filterStatus) && !!allOrdersFull;

    const filtered = useMemo(() => {
        const isSearching = !!search.trim();
        let result = usingFullSet ? allOrdersFull : orders;
        // Фільтр по менеджеру
        if (filterManager !== "all") {
            result = result.filter(o => o.uid === filterManager);
        }
        // Кошик / Архів
        if (filterStatus === "deleted") {
            result = result.filter(o => o.deleted);
        } else if (filterStatus === "archived") {
            result = result.filter(o => o.archived && !o.deleted);
        } else {
            if (!isSearching) {
                result = result.filter(o => !o.archived && !o.deleted);
            }
            if (filterStatus) {
                result = result.filter(o => {
                    const s = o.status || "new";
                    if (filterStatus === "corrections") return o.type === "file_corrections";
                    if (o.type === "file_corrections") return false;
                    if (filterStatus === "sources") return needsSources(o);
                    if (filterStatus === "writing") return s === "writing" && o.stage !== "sources";
                    if (filterStatus === "plan_ready") return s === "plan_ready" || s === "plan_approved";
                    if (filterStatus === "done") return s === "done" && !needsSources(o);
                    if (filterStatus === "new") return s === "new" && !needsSources(o);
                    return true;
                });
            }
        }
        // Пошук по тексту
        if (search.trim()) {
            const q = search.toLowerCase().trim();
            result = result.filter(o =>
                o.topic?.toLowerCase().includes(q) ||
                o.id?.toLowerCase().includes(q) ||
                o.type?.toLowerCase().includes(q) ||
                o.deadline?.toLowerCase().includes(q) ||
                o.info?.orderNumber?.toString().toLowerCase().includes(q) ||
                (isAdmin && o.managerName?.toLowerCase().includes(q))
            );
        }
        if (dlFrom || dlTo) {
            result = result.filter(o => {
                if (o.status === "done" && !needsSources(o)) return false;
                if (!o.deadline) return false;
                const [dd, mm, yy] = o.deadline.split(".");
                const d = new Date(+yy, +mm-1, +dd);
                if (dlFrom && d < dlFrom) return false;
                if (dlTo && d > dlTo) return false;
                return true;
            });
        }
        // Сортування: архів і кошик — без змін; решта — активні за обраним полем, Готово — внизу
        if (filterStatus !== "archived" && filterStatus !== "deleted") {
            const parseDeadline = (dl) => {
                if (!dl) return null;
                const parts = dl.split(".");
                if (parts.length !== 3) return null;
                return new Date(+parts[2], +parts[1] - 1, +parts[0]);
            };
            result = [...result].sort((a, b) => {
                const aDone = a.status === "done" && !needsSources(a);
                const bDone = b.status === "done" && !needsSources(b);
                // Готово — в кінець
                if (aDone && !bDone) return 1;
                if (!aDone && bDone) return -1;

                if (sortBy === "created_asc" || sortBy === "created_desc") {
                    const cA = a.createdAt || "";
                    const cB = b.createdAt || "";
                    if (cA === cB) return 0;
                    return sortBy === "created_asc" ? cA.localeCompare(cB) : cB.localeCompare(cA);
                }

                if (sortBy === "updated_asc" || sortBy === "updated_desc") {
                    const uA = a.updatedAt || a.createdAt || "";
                    const uB = b.updatedAt || b.createdAt || "";
                    if (uA === uB) return 0;
                    return sortBy === "updated_asc" ? uA.localeCompare(uB) : uB.localeCompare(uA);
                }

                // Обидва активні або обидва Готово — сортуємо за дедлайном
                const dA = parseDeadline(a.deadline);
                const dB = parseDeadline(b.deadline);
                if (!dA && !dB) return 0;
                if (!dA) return 1;  // без дедлайну — в кінець
                if (!dB) return -1;
                return sortBy === "deadline_desc" ? dB - dA : dA - dB;
            });
        }
        return result;
    }, [orders, allOrdersFull, search, filterStatus, dlFrom, dlTo, sortBy, filterManager, isAdmin, usingFullSet]);

    const toggleSelectAll = () => {
        setSelectedIds(prev => {
            const allSelected = filtered.length > 0 && filtered.every(o => prev.has(o.id));
            return allSelected ? new Set() : new Set(filtered.map(o => o.id));
        });
    };

    const counts = useMemo(() => {
        const c = { all: 0, done: 0, writing: 0, sources: 0, plan_ready: 0, new: 0, archived: 0, corrections: 0, deleted: 0 };
        orders.forEach(o => {
            if (o.deleted) { c.deleted++; return; }
            if (o.archived) { c.archived++; return; }
            c.all++;
            if (o.type === "file_corrections") { c.corrections++; return; }
            const s = o.status || "new";
            if (needsSources(o)) c.sources++;
            else if (s === "done") c.done++;
            else if (s === "writing") c.writing++;
            else if (s === "plan_ready" || s === "plan_approved") c.plan_ready++;
            else c.new++;
        });
        return c;
    }, [orders]);

    return (
        <div style={{ minHeight: "100vh", background: "#f5f2eb", fontFamily: "'Spectral', Georgia, serif" }}>
            <style>{`@import url('https://fonts.googleapis.com/css2?family=Spectral:wght@400;600&family=Spectral+SC:wght@600&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>

            {/* Header */}
            <div style={{ background: "#1a1a14", color: "#f5f2eb", padding: "16px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 20, letterSpacing: 4, color: "#e8ff47" }}>ACADEM</div>
                    <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 20, letterSpacing: 4 }}>ASSIST</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <button onClick={() => setShowMyStats(true)} style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Мої результати</button>
                    {profile?.role === "admin" && (
                        <button onClick={() => setShowStats(true)} style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Статистика</button>
                    )}
                    {onTraining && (
                        <button onClick={onTraining} style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>
                            Навчання
                        </button>
                    )}
                    {onAdmin && (
                        <button onClick={onAdmin} style={{ background: "#e8ff47", color: "#1a1a14", border: "none", borderRadius: 6, padding: "6px 16px", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700 }}>
                            ⚙ Адмін
                        </button>
                    )}
                    <div style={{ fontSize: 13, color: "#888" }}>{profile?.name || user.email}</div>
                    <button onClick={logout} style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Вийти</button>
                </div>
            </div>

            <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px clamp(16px, 3vw, 48px)" }}>

                {/* Top bar */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
                    <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 18, letterSpacing: 2, color: "#1a1a14" }}>{isAdmin ? "ВСІ ЗАМОВЛЕННЯ" : "МОЇ ЗАМОВЛЕННЯ"}</div>
                    <div style={{ display: "flex", gap: 8 }}>
                        {onFileCorrections && (
                            <button onClick={onFileCorrections} style={{ background: "transparent", color: "#6a3a00", border: "1.5px solid #c47a30", borderRadius: 7, padding: "9px 18px", fontSize: 12, fontWeight: 600, cursor: "pointer", letterSpacing: 1, fontFamily: "inherit" }}>
                                ✏ Правки до файлу
                            </button>
                        )}
                        <button onClick={() => onNew("practice")} style={{ background: "transparent", color: "#5a1a8a", border: "1.5px solid #5a1a8a", borderRadius: 7, padding: "9px 18px", fontSize: 12, fontWeight: 600, cursor: "pointer", letterSpacing: 1, fontFamily: "inherit" }}>
                            + Практика
                        </button>
                        <button onClick={() => onNew("small")} style={{ background: "transparent", color: "#1a1a14", border: "1.5px solid #1a1a14", borderRadius: 7, padding: "9px 18px", fontSize: 12, fontWeight: 600, cursor: "pointer", letterSpacing: 1, fontFamily: "inherit" }}>
                            + Мала робота
                        </button>
                        <button onClick={() => onNew("large")} style={{ background: "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 7, padding: "10px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer", letterSpacing: 1, fontFamily: "inherit" }}>
                            + Нове замовлення
                        </button>
                    </div>
                </div>

                {/* Stats */}
                {!loading && orders.length > 0 && isAdmin && !serverCounts ? (
                    <div style={{ marginBottom: 20, fontSize: 12, color: "#bbb" }}>Рахуємо статистику...</div>
                ) : !loading && orders.length > 0 && (
                    <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap", alignItems: "center" }}>
                        {[
                            { label: "Всього", val: (serverCounts ?? counts).all, color: "#1a1a14", bg: "#e8e4d8", key: null },
                            { label: "План", val: (serverCounts ?? counts).plan_ready, color: "#1a5a8a", bg: "#e4f0ff", key: "plan_ready" },
                            { label: "В роботі", val: (serverCounts ?? counts).writing, color: "#2a7a6a", bg: "#e4f5f2", key: "writing" },
                            { label: "Джерела", val: (serverCounts ?? counts).sources, color: "#8a5a1a", bg: "#fff3e0", key: "sources" },
                            { label: "Готово", val: (serverCounts ?? counts).done, color: "#1a6a1a", bg: "#e4ffe4", key: "done" },
                            ...((serverCounts ?? counts).corrections > 0 ? [{ label: "Правки", val: (serverCounts ?? counts).corrections, color: "#6a3a00", bg: "#fff0e0", key: "corrections" }] : []),
                            ...(isAdmin && (serverCounts ?? counts).archived > 0 ? [{ label: "Архів", val: (serverCounts ?? counts).archived, color: "#666", bg: "#ebebeb", key: "archived" }] : []),
                            ...(isAdmin && (serverCounts ?? counts).deleted > 0 ? [{ label: "Кошик", val: (serverCounts ?? counts).deleted, color: "#c00", bg: "#fff0f0", key: "deleted" }] : []),
                        ].map(s => {
                            const isActive = filterStatus === s.key;
                            return (
                                <div key={s.label}
                                    onClick={() => { setFilterStatus(isActive ? null : s.key); setSelectedIds(new Set()); }}
                                    style={{
                                        padding: "8px 18px", borderRadius: 20, background: isActive ? s.color : s.bg,
                                        color: isActive ? "#fff" : s.color, fontSize: 12, fontWeight: 600,
                                        cursor: "pointer", transition: "all .15s",
                                        border: isActive ? `2px solid ${s.color}` : "2px solid transparent",
                                        userSelect: "none"
                                    }}>
                                    {s.val} {s.label}
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* Deadline + Manager + Sort filters (not in archive/trash view) */}
                {orders.length > 0 && filterStatus !== "archived" && filterStatus !== "deleted" && (
                    <div style={{ display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 0 }}>
                        {isAdmin && <DeadlinePicker dlFrom={dlFrom} dlTo={dlTo} setDlFrom={setDlFrom} setDlTo={setDlTo} />}
                        {isAdmin && (
                            <div style={{ marginBottom: 12 }}>
                                <div style={{ fontSize: 11, color: "#aaa", fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>Менеджер</div>
                                <select value={filterManager} onChange={e => setFilterManager(e.target.value)}
                                    style={{ padding: "7px 12px", border: `1.5px solid ${filterManager !== "all" ? "#1a1a14" : "#d4cfc4"}`, borderRadius: 8, fontSize: 13, fontFamily: "'Spectral',serif", background: "#fff", color: filterManager !== "all" ? "#1a1a14" : "#aaa", outline: "none", cursor: "pointer" }}>
                                    <option value="all">Всі менеджери</option>
                                    {Object.entries(userMap)
                                        .filter(([, u]) => u.role === "manager" || u.role === "admin")
                                        .map(([uid, u]) => (
                                            <option key={uid} value={uid}>{u.name || u.email}</option>
                                        ))}
                                </select>
                            </div>
                        )}
                        <div style={{ marginBottom: 12 }}>
                            <div style={{ fontSize: 11, color: "#aaa", fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>Сортування</div>
                            <select value={sortBy} onChange={e => setSortBy(e.target.value)}
                                style={{ padding: "7px 12px", border: `1.5px solid ${sortBy !== "updated_desc" ? "#1a1a14" : "#d4cfc4"}`, borderRadius: 8, fontSize: 13, fontFamily: "'Spectral',serif", background: "#fff", color: "#1a1a14", outline: "none", cursor: "pointer" }}>
                                <option value="updated_desc">Останнє редагування: спочатку нові</option>
                                <option value="updated_asc">Останнє редагування: спочатку старі</option>
                                <option value="deadline_asc">Дедлайн: найближчі спочатку</option>
                                <option value="deadline_desc">Дедлайн: найдальші спочатку</option>
                                <option value="created_desc">Дата створення: нові спочатку</option>
                                <option value="created_asc">Дата створення: старі спочатку</option>
                            </select>
                        </div>
                    </div>
                )}

                {/* Search */}
                {orders.length > 0 && (
                    <div style={{ marginBottom: 18, position: "relative" }}>
                        <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", fontSize: 16, color: "#aaa" }}>🔍</span>
                        <input
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder={isAdmin ? "Пошук за темою, типом, дедлайном, номером замовлення, менеджером..." : "Пошук за темою, типом, дедлайном, номером замовлення..."}
                            style={{ width: "100%", padding: "11px 14px 11px 40px", border: "1.5px solid #d4cfc4", borderRadius: 8, fontSize: 14, fontFamily: "'Spectral',serif", background: "#fff", color: "#1a1a14", outline: "none" }}
                        />
                        {search && (
                            <button onClick={() => setSearch("")} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "#aaa", lineHeight: 1 }}>✕</button>
                        )}
                    </div>
                )}

                {/* List */}
                {loading ? (
                    <div style={{ textAlign: "center", padding: 60, color: "#888" }}>
                        <div style={{ fontSize: 14 }}>Завантаження...</div>
                    </div>
                ) : orders.length === 0 ? (
                    <div style={{ background: "#fff", borderRadius: 12, padding: 56, textAlign: "center", boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                        <div style={{ fontSize: 40, marginBottom: 16 }}>📄</div>
                        <div style={{ fontSize: 16, color: "#888", marginBottom: 20 }}>Замовлень ще немає</div>
                        <button onClick={onNew} style={{ background: "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 7, padding: "10px 24px", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
                            Створити перше замовлення →
                        </button>
                    </div>
                ) : isAdmin && (search.trim() || filterStatus) && !allOrdersFull ? (
                    <div style={{ textAlign: "center", padding: 40, color: "#888", fontSize: 14 }}>Завантаження повного списку...</div>
                ) : filtered.length === 0 ? (
                    <div style={{ textAlign: "center", padding: 40, color: "#888", fontSize: 14 }}>
                        {filterStatus === "archived" ? "Архів порожній" : filterStatus === "deleted" ? "Кошик порожній" : search ? `Нічого не знайдено за запитом «${search}»` : "Немає замовлень у цьому фільтрі"}
                    </div>
                ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        {isAdmin && hasMore && !usingFullSet && (
                            <div style={{ textAlign: "center", padding: "4px 0 8px" }}>
                                <span style={{ fontSize: 12, color: "#aaa" }}>Показано перші {orders.length} замовлень</span>
                            </div>
                        )}
                        {(filterStatus !== "deleted" || isAdmin) && (
                            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 4px 4px", flexWrap: "wrap" }}>
                                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#888", cursor: "pointer", userSelect: "none" }}>
                                    <input type="checkbox" checked={filtered.length > 0 && filtered.every(o => selectedIds.has(o.id))} onChange={toggleSelectAll} style={{ cursor: "pointer" }} />
                                    Обрати всі ({filtered.length})
                                </label>
                                {selectedIds.size > 0 && (<>
                                    <span style={{ fontSize: 12, color: "#aaa" }}>Виділено: {selectedIds.size}</span>
                                    <button onClick={() => setSelectedIds(new Set())}
                                        style={{ background: "transparent", border: "1px solid #eee", color: "#888", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer" }}>
                                        Зняти виділення
                                    </button>
                                    {filterStatus === "deleted" ? (<>
                                        <button onClick={bulkRestore}
                                            style={{ background: "#e4ffe4", border: "1px solid #4aba4a50", color: "#1a6a1a", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
                                            ↩ Відновити ({selectedIds.size})
                                        </button>
                                        <button onClick={bulkPermanentDelete}
                                            style={{ background: "transparent", border: "1px solid #f99", color: "#c55", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer" }}>
                                            ✕✕ Видалити назавжди ({selectedIds.size})
                                        </button>
                                    </>) : (
                                        <button onClick={bulkMoveToTrash}
                                            style={{ background: "transparent", border: "1px solid #f99", color: "#c55", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
                                            🗑 У кошик ({selectedIds.size})
                                        </button>
                                    )}
                                </>)}
                            </div>
                        )}
                        {filtered.map(order => {
                            const isCorrections = order.type === "file_corrections";
                            const st = isCorrections
                                ? STATUS_LABELS.file_corrections
                                : (needsSources(order) ? STATUS_LABELS.sources : null) || STATUS_LABELS[order.status] || STATUS_LABELS.new;
                            const isSmall = order.mode === "small";
                            const isPractice = order.mode === "practice";
                            return (
                                <div key={order.id} onClick={() => onOpen(order.id, isCorrections ? "file_corrections" : (order.mode || "large"))}
                                    style={{ background: "#fff", borderRadius: 10, padding: "16px 20px", cursor: "pointer", boxShadow: "0 2px 8px rgba(0,0,0,0.05)", display: "flex", alignItems: "center", gap: 14, transition: "box-shadow .2s" }}
                                    onMouseEnter={e => e.currentTarget.style.boxShadow = "0 4px 18px rgba(0,0,0,0.10)"}
                                    onMouseLeave={e => e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.05)"}>

                                    {/* Select checkbox */}
                                    {(filterStatus !== "deleted" || isAdmin) && (
                                        <div onClick={e => e.stopPropagation()} style={{ flexShrink: 0 }}>
                                            <input type="checkbox" checked={selectedIds.has(order.id)} onChange={e => toggleSelect(order.id, e)} style={{ cursor: "pointer", width: 16, height: 16 }} />
                                        </div>
                                    )}

                                    {/* Status dot */}
                                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: st.dot, flexShrink: 0 }} />

                                    {/* Info */}
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontSize: 15, fontWeight: 600, color: "#1a1a14", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                            {order.topic || order.info?.topic || "Без теми"}
                                        </div>
                                        <div style={{ fontSize: 12, color: "#888", display: "flex", gap: 12, flexWrap: "wrap" }}>
                                            {isAdmin && order.managerName && <span style={{ background: "#e8f0ff", color: "#1a3a8a", padding: "1px 8px", borderRadius: 8, fontSize: 11, fontWeight: 600 }}>👤 {order.managerName}</span>}
                                            {filterStatus !== "deleted" && order.deleted && <span style={{ background: "#ffe4e4", color: "#8a1a1a", padding: "1px 8px", borderRadius: 8, fontSize: 11, fontWeight: 600 }}>🗑 У кошику</span>}
                                            {filterStatus !== "archived" && !order.deleted && order.archived && <span style={{ background: "#f0f0f0", color: "#555", padding: "1px 8px", borderRadius: 8, fontSize: 11, fontWeight: 600 }}>📦 В архіві</span>}
                                            {isCorrections && <span style={{ background: "#fff0e0", color: "#6a3a00", padding: "1px 8px", borderRadius: 8, fontSize: 11 }}>✏ Правки</span>}
                                            {isPractice && <span style={{ background: "#f0e4ff", color: "#5a1a8a", padding: "1px 8px", borderRadius: 8, fontSize: 11 }}>🏭 Практика</span>}
                                            {isSmall && <span style={{ background: "#f0e4ff", color: "#5a1a8a", padding: "1px 8px", borderRadius: 8, fontSize: 11 }}>📝 Мала</span>}
                                            {order.type && <span>{order.type}</span>}
                                            {order.pages && <span>{order.pages} стор.</span>}
                                            {order.deadline && <span>⏰ {order.deadline}</span>}
                                            <span style={{ color: "#bbb" }}>{order.createdAt?.slice(0, 10) || ""}</span>
                                            {order.info?.orderNumber && <span style={{ background: "#f0e8ff", color: "#5a1a8a", padding: "1px 8px", borderRadius: 8, fontSize: 11, fontFamily: "monospace" }}>№ {order.info.orderNumber}</span>}
                                            <span style={{ color: "#ccc", fontFamily: "monospace", fontSize: 10 }}>#{order.id.slice(0, 8)}</span>
                                        </div>
                                    </div>

                                    {/* Status badge */}
                                    <div style={{ padding: "4px 12px", borderRadius: 20, fontSize: 11, fontWeight: 600, background: st.bg, color: st.color, whiteSpace: "nowrap", flexShrink: 0 }}>
                                        {st.label}
                                    </div>

                                    {/* Delete */}
                                    {isAdmin && (
                                        <div style={{ position: "relative", flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                                            <button
                                                onClick={e => { e.stopPropagation(); setTransferOrderId(transferOrderId === order.id ? null : order.id); }}
                                                style={{ background: "#f0eeff", border: "1px solid #c4b0ff", color: "#5533cc", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}
                                                onMouseEnter={e => { e.currentTarget.style.background = "#e0d8ff"; }}
                                                onMouseLeave={e => { e.currentTarget.style.background = "#f0eeff"; }}
                                                title="Передати менеджеру">
                                                ↪
                                            </button>
                                            {transferOrderId === order.id && (
                                                <div style={{ position: "absolute", right: 0, top: "110%", background: "#fff", border: "1px solid #ddd", borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", zIndex: 100, minWidth: 180, padding: "6px 0" }}>
                                                    <div style={{ fontSize: 11, color: "#888", padding: "4px 14px 6px", borderBottom: "1px solid #f0f0f0" }}>Передати замовлення:</div>
                                                    {Object.entries(userMap)
                                                        .filter(([, u]) => u.role === "manager" || u.role === "admin")
                                                        .map(([uid, u]) => (
                                                            <div key={uid}
                                                                onClick={e => transferOrder(order.id, uid, e)}
                                                                style={{ padding: "7px 14px", fontSize: 13, cursor: "pointer", color: order.uid === uid ? "#1a5a8a" : "#222", fontWeight: order.uid === uid ? 700 : 400 }}
                                                                onMouseEnter={e => e.currentTarget.style.background = "#f5f5ff"}
                                                                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                                                                {u.name || u.email}
                                                                {order.uid === uid && " ✓"}
                                                            </div>
                                                        ))}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    {filterStatus === "deleted" ? (
                                        isAdmin && (<>
                                            <button onClick={e => restoreOrder(order.id, e)}
                                                title="Відновити"
                                                style={{ background: "#e4ffe4", border: "1px solid #4aba4a50", color: "#1a6a1a", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer", flexShrink: 0, fontWeight: 600 }}
                                                onMouseEnter={e => { e.currentTarget.style.background = "#c8f0c8"; }}
                                                onMouseLeave={e => { e.currentTarget.style.background = "#e4ffe4"; }}>
                                                ↩ Відновити
                                            </button>
                                            <button onClick={e => permanentDelete(order.id, e)}
                                                title="Видалити назавжди"
                                                style={{ background: "transparent", border: "1px solid #f99", color: "#c55", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer", flexShrink: 0 }}
                                                onMouseEnter={e => { e.currentTarget.style.background = "#fff0f0"; }}
                                                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>
                                                ✕✕
                                            </button>
                                        </>)
                                    ) : (<>
                                        {isAdmin && (
                                            <button onClick={e => archiveOrder(order.id, !order.archived, e)}
                                                title={order.archived ? "Розархівувати" : "Архівувати"}
                                                style={{ background: "transparent", border: "1px solid #eee", color: "#bbb", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer", flexShrink: 0 }}
                                                onMouseEnter={e => { e.currentTarget.style.borderColor = "#bbb"; e.currentTarget.style.color = "#555"; }}
                                                onMouseLeave={e => { e.currentTarget.style.borderColor = "#eee"; e.currentTarget.style.color = "#bbb"; }}>
                                                {order.archived ? "↩" : "🗄"}
                                            </button>
                                        )}
                                        <button onClick={e => moveToTrash(order.id, e)}
                                            title="В кошик"
                                            style={{ background: "transparent", border: "1px solid #eee", color: "#ccc", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer", flexShrink: 0 }}
                                            onMouseEnter={e => { e.currentTarget.style.borderColor = "#f99"; e.currentTarget.style.color = "#c55"; }}
                                            onMouseLeave={e => { e.currentTarget.style.borderColor = "#eee"; e.currentTarget.style.color = "#ccc"; }}>
                                            🗑
                                        </button>
                                    </>)}
                                </div>
                            );
                        })}
                        {isAdmin && hasMore && !usingFullSet && (
                            <div style={{ textAlign: "center", padding: "16px 0 4px" }}>
                                <button
                                    onClick={loadMore}
                                    disabled={loadingMore}
                                    style={{ background: loadingMore ? "#f0ece2" : "#fff", border: "1.5px solid #d4cfc4", color: "#555", borderRadius: 8, padding: "10px 28px", fontSize: 13, fontFamily: "'Spectral',serif", cursor: loadingMore ? "default" : "pointer", fontWeight: 500 }}>
                                    {loadingMore ? "Завантаження..." : `Завантажити ще (показано ${orders.length})`}
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Модалка інструкції */}
            {showHelp && (
                <div onClick={() => setShowHelp(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
                    <div onClick={e => e.stopPropagation()} style={{ background: "#1a1a14", borderRadius: 14, padding: "32px 36px", maxWidth: 680, width: "100%", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 12px 60px rgba(0,0,0,0.5)", fontFamily: "'Spectral',Georgia,serif", color: "#f5f2eb" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
                            <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 16, letterSpacing: 3, color: "#e8ff47" }}>ІНСТРУКЦІЯ</div>
                            <button onClick={() => setShowHelp(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#888", lineHeight: 1 }}>✕</button>
                        </div>
                        {[
                            { title: "Що це за програма?", body: "ACADEM ASSIST — AI-асистент для написання академічних робіт. Він автоматично генерує текст курсових, дипломних та інших робіт на основі твоїх даних." },
                            { title: "Типи робіт", body: "Нове замовлення — для курсових, дипломних, бакалаврських робіт.\nМала робота — для рефератів, тез, статей, есе, презентацій." },
                            { title: "Крок 1 — Введення даних", body: "Вставте текст шаблону замовлення (бланк від викладача). За потреби додайте коментар та завантажте методичку (PDF). Якщо є готовий план — вставте або сфотографуйте його. Натисніть «Аналізувати»." },
                            { title: "Крок 2 — Перевірка даних", body: "Перевірте витягнуті дані: тему, напрям, кількість сторінок, мову, дедлайн. Відредагуйте за потреби. Натисніть «Генерувати план»." },
                            { title: "Крок 3 — План роботи", body: "Переглянте та відредагуйте назви розділів і підрозділів. Натисніть «Затвердити план» щоб розпочати написання." },
                            { title: "Крок 4 — Написання тексту", body: "Система генерує текст по кожному підрозділу поступово. Прогрес відображається у верхній панелі. Можна зупинити і продовжити пізніше. Кожен підрозділ можна перегенерувати з додатковими вимогами." },
                            { title: "Крок 5 — Джерела", body: "Введіть реальні джерела для кожного підрозділу. Скористайтесь кнопкою «Ключові слова» щоб знайти релевантні запити для пошуку. Натисніть «Сформувати список літератури»." },
                            { title: "Крок 6 — Готово", body: "Завантажити .docx — готова робота з титульною сторінкою.\nДоповідь — текст для захисту у .docx.\nПрезентація — автоматичний .pptx.\nДодатки — генерує додатки до роботи.\nКопіювати текст — весь текст у буфер обміну." },
                            { title: "Малі роботи", body: "Натисніть «Мала робота», оберіть тип (Реферат / Тези / Стаття / Есе / Презентація), заповніть форму і натисніть «Генерувати». Завантажте результат у .docx або .pptx." },
                            { title: "Корисні поради", body: "Методичка значно покращує якість роботи — завантажуй її якщо є.\nЯкщо генерація переривається — поверніться до замовлення і продовжіть.\nЗвук лунає коли генерація завершена, навіть якщо вкладка прихована.\nВсі дані зберігаються автоматично в хмарі." },
                        ].map(({ title, body }) => (
                            <div key={title} style={{ marginBottom: 22 }}>
                                <div style={{ fontSize: 13, fontWeight: 700, color: "#e8ff47", letterSpacing: 1, marginBottom: 6, fontFamily: "'Spectral SC',serif" }}>{title}</div>
                                <div style={{ fontSize: 13, color: "#c8c4bb", lineHeight: 1.7, whiteSpace: "pre-line" }}>{body}</div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Мої результати */}
            {showMyStats && <UserStatsModal orders={orders} onClose={() => setShowMyStats(false)} />}

            {/* Статистика (адмін) */}
            {showStats && <AdminStatsModal onClose={() => setShowStats(false)} />}

            {/* Модалка деталей замовлення */}
            {infoOrder && (
                <div onClick={() => setInfoOrder(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
                    <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, padding: 28, maxWidth: 520, width: "100%", boxShadow: "0 8px 40px rgba(0,0,0,0.18)", fontFamily: "'Spectral',Georgia,serif" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                            <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 14, letterSpacing: 2, color: "#1a1a14" }}>ДЕТАЛІ ЗАМОВЛЕННЯ</div>
                            <button onClick={() => setInfoOrder(null)} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#aaa" }}>✕</button>
                        </div>
                        <div style={{ fontSize: 11, color: "#aaa", fontFamily: "monospace", marginBottom: 16 }}>#{infoOrder.id}</div>
                        {[
                            { label: "Тема", val: infoOrder.topic },
                            { label: "Тип роботи", val: infoOrder.type },
                            { label: "Галузь / спеціальність", val: infoOrder.subject },
                            { label: "К-сть сторінок", val: infoOrder.pages },
                            { label: "Мова", val: infoOrder.language },
                            { label: "Унікальність", val: infoOrder.uniqueness },
                            { label: "Дедлайн", val: infoOrder.deadline },
                            { label: "К-сть джерел", val: infoOrder.sourceCount },
                            { label: "Додатково", val: infoOrder.extras },
                            { label: "Вимоги методички", val: infoOrder.methodNotes },
                            { label: "Дата створення", val: infoOrder.createdAt?.slice(0, 10) },
                        ].filter(r => r.val).map(r => (
                            <div key={r.label} style={{ display: "flex", gap: 12, marginBottom: 10, fontSize: 13 }}>
                                <div style={{ color: "#888", minWidth: 160, flexShrink: 0 }}>{r.label}</div>
                                <div style={{ color: "#1a1a14", fontWeight: 500 }}>{r.val}</div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
