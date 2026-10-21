import { useState, useEffect, useMemo } from "react";
import { db, auth } from "./firebase";
import { collection, getDocs, doc, updateDoc, setDoc, deleteDoc, query, orderBy, limit } from "firebase/firestore";
import { initializeApp, deleteApp } from "firebase/app";
import { getAuth, createUserWithEmailAndPassword } from "firebase/auth";
import { useAuth } from "./AuthContext";

const ROLE_LABELS = {
    admin: { label: "Адмін", color: "#8a1a8a", bg: "#f5e4ff" },
    manager: { label: "Менеджер", color: "#1a5a8a", bg: "#e4f0ff" },
    user: { label: "Користувач", color: "#555", bg: "#f0f0f0" },
};

const STATUS_META = [
    { key: "new",          label: "Нове",              color: "#888",   bg: "#f5f5f5",  dot: "#ccc"    },
    { key: "plan_ready",   label: "План готовий",       color: "#5a7a2a", bg: "#eef5e4", dot: "#8ac040" },
    { key: "plan_approved",label: "План затверджено",   color: "#1a5a8a", bg: "#e4f0ff", dot: "#4a9ade" },
    { key: "writing",      label: "В роботі",           color: "#2a7a6a", bg: "#e4f5f2", dot: "#3abfa0" },
    { key: "sources",      label: "Джерела",            color: "#8a5a1a", bg: "#fff3e0", dot: "#e8a050" },
    { key: "done",         label: "Готово",             color: "#1a6a1a", bg: "#e4ffe4", dot: "#4aba4a" },
];

const DATE_RANGES = [
    { key: "1",   label: "1 день",  days: 1   },
    { key: "2",   label: "2 дні",   days: 2   },
    { key: "7",   label: "7 днів",  days: 7   },
    { key: "30",  label: "Місяць",  days: 30  },
    { key: "90",  label: "3 місяці",days: 90  },
    { key: "all", label: "Весь час",days: null },
];

function getOrderStatus(o) {
    const s = o.status || "new";
    if (s !== "done" && o.stage === "sources") return "sources";
    return s;
}

function AdminField({ label, value, onChange, type = "text", placeholder }) {
    return (
        <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
            <input
                type={type}
                value={value}
                onChange={e => onChange(e.target.value)}
                placeholder={placeholder}
                style={{ width: "100%", padding: "9px 12px", border: "1.5px solid #ddd", borderRadius: 6, fontSize: 13, boxSizing: "border-box", fontFamily: "inherit" }}
            />
        </div>
    );
}

// ─── Вкладка статистики ───────────────────────────────────────────────────────

function StatsTab({ users }) {
    const [allOrders, setAllOrders] = useState([]);
    const [loading, setLoading] = useState(true);
    const [customFrom, setCustomFrom] = useState("");
    const [customTo, setCustomTo] = useState("");

    useEffect(() => {
        const load = async () => {
            setLoading(true);
            const snap = await getDocs(collection(db, "orders"));
            setAllOrders(snap.docs.map(d => ({ id: d.id, ...d.data() })));
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
        const counts = { total: orders.length };
        STATUS_META.forEach(s => { counts[s.key] = 0; });
        orders.forEach(o => {
            const s = getOrderStatus(o);
            if (counts[s] !== undefined) counts[s]++;
        });
        return counts;
    }, [orders]);

    const byManager = useMemo(() => {
        const userMap = {};
        users.forEach(u => { userMap[u.id] = u; });

        const map = {};
        orders.forEach(o => {
            if (!o.uid) return;
            if (!map[o.uid]) {
                map[o.uid] = { uid: o.uid, total: 0, lastOrder: null };
                STATUS_META.forEach(s => { map[o.uid][s.key] = 0; });
            }
            const s = getOrderStatus(o);
            if (map[o.uid][s] !== undefined) map[o.uid][s]++;
            map[o.uid].total++;
            if (!map[o.uid].lastOrder || o.createdAt > map[o.uid].lastOrder) {
                map[o.uid].lastOrder = o.createdAt;
            }
        });

        return Object.values(map)
            .map(row => ({ ...row, user: userMap[row.uid] }))
            .sort((a, b) => b.total - a.total);
    }, [orders, users]);

    const todayStats = useMemo(() => {
        const todayStr = new Date().toISOString().slice(0, 10);
        const userMap = {};
        users.forEach(u => { userMap[u.id] = u; });

        const createdToday = allOrders.filter(o => o.createdAt?.slice(0, 10) === todayStr);
        const doneToday = allOrders.filter(o => o.completedAt?.slice(0, 10) === todayStr);

        const map = {};
        createdToday.forEach(o => {
            if (!o.uid) return;
            if (!map[o.uid]) map[o.uid] = { uid: o.uid, created: 0, done: 0, user: userMap[o.uid] };
            map[o.uid].created++;
        });
        doneToday.forEach(o => {
            if (!o.uid) return;
            if (!map[o.uid]) map[o.uid] = { uid: o.uid, created: 0, done: 0, user: userMap[o.uid] };
            map[o.uid].done++;
        });

        return {
            createdTotal: createdToday.length,
            doneTotal: doneToday.length,
            byManager: Object.values(map).sort((a, b) => (b.created + b.done) - (a.created + a.done)),
        };
    }, [allOrders, users]);

    const formatDate = (iso) => {
        if (!iso) return "—";
        const d = new Date(iso);
        return d.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" });
    };

    if (loading) return <div style={{ padding: 32, color: "#888" }}>Завантаження статистики...</div>;

    return (
        <div>
            {/* Сьогодні */}
            <div style={{ background: "#fff", borderRadius: 10, padding: 20, marginBottom: 20, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#1a1a14", marginBottom: 16 }}>Сьогодні</div>
                <div style={{ display: "flex", gap: 12, marginBottom: todayStats.byManager.length > 0 ? 20 : 0, flexWrap: "wrap" }}>
                    <div style={{ flex: "1 1 160px", padding: "18px 20px", borderRadius: 10, background: "#1a1a14" }}>
                        <div style={{ fontSize: 36, fontWeight: 700, color: "#e8ff47", lineHeight: 1 }}>{todayStats.createdTotal}</div>
                        <div style={{ fontSize: 12, color: "#aaa", marginTop: 6 }}>Створено сьогодні</div>
                    </div>
                    <div style={{ flex: "1 1 160px", padding: "18px 20px", borderRadius: 10, background: "#e4ffe4", border: "1.5px solid #4aba4a30" }}>
                        <div style={{ fontSize: 36, fontWeight: 700, color: "#1a6a1a", lineHeight: 1 }}>{todayStats.doneTotal}</div>
                        <div style={{ fontSize: 12, color: "#1a6a1a", opacity: 0.7, marginTop: 6 }}>Готово сьогодні</div>
                    </div>
                </div>
                {todayStats.byManager.length > 0 && (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead>
                            <tr style={{ borderBottom: "2px solid #f0ece2" }}>
                                <th style={{ textAlign: "left", padding: "7px 10px", color: "#888", fontWeight: 600, fontSize: 11, letterSpacing: 1, textTransform: "uppercase" }}>Менеджер</th>
                                <th style={{ textAlign: "center", padding: "7px 10px", color: "#888", fontWeight: 600, fontSize: 11, letterSpacing: 1, textTransform: "uppercase" }}>Створено</th>
                                <th style={{ textAlign: "center", padding: "7px 10px", color: "#1a6a1a", fontWeight: 600, fontSize: 11, letterSpacing: 1, textTransform: "uppercase" }}>Готово</th>
                            </tr>
                        </thead>
                        <tbody>
                            {todayStats.byManager.map((row, i) => (
                                <tr key={row.uid} style={{ borderBottom: "1px solid #f0ece2", background: i % 2 === 0 ? "transparent" : "#faf8f3" }}>
                                    <td style={{ padding: "9px 10px" }}>
                                        <div style={{ fontWeight: 600, color: "#1a1a14" }}>{row.user?.name || "—"}</div>
                                        <div style={{ fontSize: 11, color: "#aaa" }}>{row.user?.email || row.uid}</div>
                                    </td>
                                    <td style={{ textAlign: "center", padding: "9px 10px" }}>
                                        {row.created > 0
                                            ? <span style={{ display: "inline-block", minWidth: 28, padding: "2px 10px", borderRadius: 12, background: "#1a1a14", color: "#e8ff47", fontWeight: 700, fontSize: 13 }}>{row.created}</span>
                                            : <span style={{ color: "#ddd" }}>—</span>}
                                    </td>
                                    <td style={{ textAlign: "center", padding: "9px 10px" }}>
                                        {row.done > 0
                                            ? <span style={{ display: "inline-block", minWidth: 28, padding: "2px 10px", borderRadius: 12, background: "#e4ffe4", color: "#1a6a1a", fontWeight: 700, fontSize: 13, border: "1.5px solid #4aba4a30" }}>{row.done}</span>
                                            : <span style={{ color: "#ddd" }}>—</span>}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                {todayStats.byManager.length === 0 && todayStats.createdTotal === 0 && todayStats.doneTotal === 0 && (
                    <div style={{ color: "#bbb", fontSize: 13 }}>Сьогодні активності ще не було</div>
                )}
            </div>

            {/* Фільтр по даті */}
            <div style={{ background: "#fff", borderRadius: 10, padding: "16px 20px", marginBottom: 20, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                <div style={{ fontSize: 11, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>Період</div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 12, color: "#888" }}>Від</span>
                        <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                            style={{ padding: "6px 10px", border: `1.5px solid ${customFrom ? "#1a1a14" : "#e0ddd4"}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", outline: "none", cursor: "pointer" }} />
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 12, color: "#888" }}>До</span>
                        <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
                            style={{ padding: "6px 10px", border: `1.5px solid ${customTo ? "#1a1a14" : "#e0ddd4"}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", outline: "none", cursor: "pointer" }} />
                    </div>
                    {(customFrom || customTo) && (
                        <button onClick={() => { setCustomFrom(""); setCustomTo(""); }}
                            style={{ padding: "6px 12px", borderRadius: 7, border: "1.5px solid #e0ddd4", background: "transparent", color: "#888", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                            Скинути ✕
                        </button>
                    )}
                    {!customFrom && !customTo && <span style={{ fontSize: 11, color: "#bbb" }}>— весь час</span>}
                </div>
            </div>

            {/* Загальна статистика */}
            <div style={{ background: "#fff", borderRadius: 10, padding: 20, marginBottom: 20, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#1a1a14", marginBottom: 16 }}>Загальна статистика</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 12 }}>
                    {/* Всього */}
                    <div style={{ padding: "14px 16px", borderRadius: 10, background: "#1a1a14", border: "none" }}>
                        <div style={{ fontSize: 28, fontWeight: 700, color: "#e8ff47", lineHeight: 1 }}>{overall.total}</div>
                        <div style={{ fontSize: 12, color: "#aaa", marginTop: 4 }}>Всього</div>
                    </div>
                    {/* По статусах */}
                    {STATUS_META.map(s => (
                        <div key={s.key} style={{ padding: "14px 16px", borderRadius: 10, background: s.bg, border: `1.5px solid ${s.dot}30` }}>
                            <div style={{ fontSize: 28, fontWeight: 700, color: s.color, lineHeight: 1 }}>{overall[s.key]}</div>
                            <div style={{ fontSize: 11, color: s.color, opacity: 0.8, marginTop: 4 }}>{s.label}</div>
                        </div>
                    ))}
                </div>
            </div>

            {/* По менеджерам */}
            <div style={{ background: "#fff", borderRadius: 10, padding: 20, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#1a1a14", marginBottom: 16 }}>По менеджерам</div>
                {byManager.length === 0 ? (
                    <div style={{ color: "#aaa", fontSize: 14 }}>Немає даних за вибраний період</div>
                ) : (
                    <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                            <thead>
                                <tr style={{ borderBottom: "2px solid #f0ece2" }}>
                                    <th style={{ textAlign: "left", padding: "8px 10px", color: "#888", fontWeight: 600, fontSize: 11, letterSpacing: 1, textTransform: "uppercase" }}>Менеджер</th>
                                    <th style={{ textAlign: "center", padding: "8px 10px", color: "#888", fontWeight: 600, fontSize: 11, letterSpacing: 1, textTransform: "uppercase" }}>Всього</th>
                                    {STATUS_META.map(s => (
                                        <th key={s.key} style={{ textAlign: "center", padding: "8px 6px", color: s.color, fontWeight: 600, fontSize: 10, letterSpacing: 0.5, whiteSpace: "nowrap" }}>{s.label}</th>
                                    ))}
                                    <th style={{ textAlign: "center", padding: "8px 10px", color: "#888", fontWeight: 600, fontSize: 11, letterSpacing: 1, textTransform: "uppercase", whiteSpace: "nowrap" }}>Останнє</th>
                                </tr>
                            </thead>
                            <tbody>
                                {byManager.map((row, i) => (
                                    <tr key={row.uid} style={{ borderBottom: "1px solid #f0ece2", background: i % 2 === 0 ? "transparent" : "#faf8f3" }}>
                                        <td style={{ padding: "10px 10px" }}>
                                            <div style={{ fontWeight: 600, color: "#1a1a14" }}>{row.user?.name || "—"}</div>
                                            <div style={{ fontSize: 11, color: "#aaa" }}>{row.user?.email || row.uid}</div>
                                        </td>
                                        <td style={{ textAlign: "center", padding: "10px", fontWeight: 700, fontSize: 15, color: "#1a1a14" }}>{row.total}</td>
                                        {STATUS_META.map(s => (
                                            <td key={s.key} style={{ textAlign: "center", padding: "10px 6px" }}>
                                                {row[s.key] > 0 ? (
                                                    <span style={{ display: "inline-block", minWidth: 24, padding: "2px 8px", borderRadius: 12, background: s.bg, color: s.color, fontWeight: 600, fontSize: 12 }}>
                                                        {row[s.key]}
                                                    </span>
                                                ) : (
                                                    <span style={{ color: "#ddd" }}>—</span>
                                                )}
                                            </td>
                                        ))}
                                        <td style={{ textAlign: "center", padding: "10px", color: "#888", fontSize: 12, whiteSpace: "nowrap" }}>{formatDate(row.lastOrder)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── Вкладка витрат ──────────────────────────────────────────────────────────

function CostsTab({ users }) {
    const [allOrders, setAllOrders] = useState([]);
    const [loading, setLoading] = useState(true);
    const [customFrom, setCustomFrom] = useState("");
    const [customTo, setCustomTo] = useState("");
    const [filterUid, setFilterUid] = useState("all");
    const [searchNum, setSearchNum] = useState("");

    useEffect(() => {
        const load = async () => {
            setLoading(true);
            const snap = await getDocs(collection(db, "orders"));
            setAllOrders(snap.docs.map(d => ({ id: d.id, ...d.data() })));
            setLoading(false);
        };
        load();
    }, []);

    const orders = useMemo(() => {
        let result = allOrders.filter(o => o.totalCostUsd !== undefined);
        if (filterUid !== "all") result = result.filter(o => o.uid === filterUid);
        const from = customFrom ? new Date(customFrom + "T00:00:00") : null;
        const to = customTo ? new Date(customTo + "T23:59:59") : null;
        if (from || to) {
            result = result.filter(o => {
                if (!o.createdAt) return false;
                const d = new Date(o.createdAt);
                if (from && d < from) return false;
                if (to && d > to) return false;
                return true;
            });
        }
        if (searchNum.trim()) {
            const q = searchNum.trim().toLowerCase();
            result = result.filter(o =>
                o.info?.orderNumber?.toString().toLowerCase().includes(q) ||
                o.info?.topic?.toLowerCase().includes(q) ||
                o.topic?.toLowerCase().includes(q)
            );
        }
        return result.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    }, [allOrders, customFrom, customTo, filterUid, searchNum]);

    const userMap = useMemo(() => {
        const m = {};
        users.forEach(u => { m[u.id] = u; });
        return m;
    }, [users]);

    const totals = useMemo(() => {
        const byManager = {};
        let grandIn = 0, grandOut = 0, grandCost = 0;
        let grandClaudeIn = 0, grandClaudeOut = 0, grandClaudeCost = 0;
        let grandGeminiIn = 0, grandGeminiOut = 0, grandGeminiCost = 0;
        let grandSerperCredits = 0, grandSerperCost = 0;
        let grandDurationSec = 0;
        orders.forEach(o => {
            grandIn += o.totalInTok || 0;
            grandOut += o.totalOutTok || 0;
            grandCost += o.totalCostUsd || 0;
            grandClaudeIn += o.claudeInTok || 0;
            grandClaudeOut += o.claudeOutTok || 0;
            grandClaudeCost += o.claudeCostUsd || 0;
            grandGeminiIn += o.geminiInTok || 0;
            grandGeminiOut += o.geminiOutTok || 0;
            grandGeminiCost += o.geminiCostUsd || 0;
            grandSerperCredits += o.serperCredits || 0;
            grandSerperCost += o.serperCostUsd || 0;
            grandDurationSec += o.generationDurationSec || 0;
            const uid = o.uid || "—";
            if (!byManager[uid]) byManager[uid] = { inTok: 0, outTok: 0, costUsd: 0, claudeInTok: 0, claudeOutTok: 0, claudeCostUsd: 0, geminiInTok: 0, geminiOutTok: 0, geminiCostUsd: 0, serperCredits: 0, serperCostUsd: 0, count: 0, durationSec: 0 };
            byManager[uid].inTok += o.totalInTok || 0;
            byManager[uid].outTok += o.totalOutTok || 0;
            byManager[uid].costUsd += o.totalCostUsd || 0;
            byManager[uid].claudeInTok += o.claudeInTok || 0;
            byManager[uid].claudeOutTok += o.claudeOutTok || 0;
            byManager[uid].claudeCostUsd += o.claudeCostUsd || 0;
            byManager[uid].geminiInTok += o.geminiInTok || 0;
            byManager[uid].geminiOutTok += o.geminiOutTok || 0;
            byManager[uid].geminiCostUsd += o.geminiCostUsd || 0;
            byManager[uid].serperCredits += o.serperCredits || 0;
            byManager[uid].serperCostUsd += o.serperCostUsd || 0;
            byManager[uid].durationSec += o.generationDurationSec || 0;
            byManager[uid].count++;
        });
        return { grandIn, grandOut, grandCost, grandClaudeIn, grandClaudeOut, grandClaudeCost, grandGeminiIn, grandGeminiOut, grandGeminiCost, grandSerperCredits, grandSerperCost, grandDurationSec, byManager };
    }, [orders]);

    const fmt = iso => iso ? new Date(iso).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";
    const fmtTok = n => n >= 1000 ? (n / 1000).toFixed(1) + "k" : (n || 0).toString();
    const fmtCost = n => "$" + (n || 0).toFixed(4);
    const fmtDur = s => {
        if (!s) return "—";
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        if (h > 0) return `${h}год ${m}хв`;
        return `${m}хв`;
    };

    const exportCSV = () => {
        const header = ["Дата", "Менеджер", "№ замовлення", "Тип роботи", "К-сть сторінок", "Разом USD", "Час виконання"];
        const rows = orders.map(o => {
            const u = userMap[o.uid];
            return [
                fmt(o.createdAt),
                u?.name || "—",
                o.info?.orderNumber || "—",
                o.type || o.workType || "—",
                o.pages || "—",
                (o.totalCostUsd || 0).toFixed(4),
                fmtDur(o.generationDurationSec),
            ];
        });
        const csv = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
        const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `vitrati_${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };

    if (loading) return <div style={{ padding: 32, color: "#888" }}>Завантаження...</div>;

    const managersWithData = Object.entries(totals.byManager).map(([uid, data]) => ({
        uid, ...data, user: userMap[uid],
    })).sort((a, b) => b.costUsd - a.costUsd);

    return (
        <div>
            {/* Фільтри */}
            <div style={{ background: "#fff", borderRadius: 10, padding: "16px 20px", marginBottom: 20, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                <div style={{ fontSize: 11, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>Фільтри</div>
                <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 12, color: "#888" }}>Від</span>
                        <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                            style={{ padding: "6px 10px", border: `1.5px solid ${customFrom ? "#1a1a14" : "#e0ddd4"}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", outline: "none" }} />
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 12, color: "#888" }}>До</span>
                        <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
                            style={{ padding: "6px 10px", border: `1.5px solid ${customTo ? "#1a1a14" : "#e0ddd4"}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", outline: "none" }} />
                    </div>
                    <select value={filterUid} onChange={e => setFilterUid(e.target.value)}
                        style={{ padding: "6px 10px", border: "1.5px solid #e0ddd4", borderRadius: 7, fontSize: 13, fontFamily: "inherit", outline: "none", background: "#fff" }}>
                        <option value="all">Всі менеджери</option>
                        {users.map(u => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
                    </select>
                    <div style={{ position: "relative" }}>
                        <input
                            value={searchNum}
                            onChange={e => setSearchNum(e.target.value)}
                            placeholder="№ або тема"
                            style={{ padding: "6px 28px 6px 10px", border: `1.5px solid ${searchNum ? "#1a1a14" : "#e0ddd4"}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", outline: "none", width: 140 }}
                        />
                        {searchNum && (
                            <button onClick={() => setSearchNum("")}
                                style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", fontSize: 13, color: "#aaa", lineHeight: 1 }}>✕</button>
                        )}
                    </div>
                    {(customFrom || customTo || filterUid !== "all" || searchNum) && (
                        <button onClick={() => { setCustomFrom(""); setCustomTo(""); setFilterUid("all"); setSearchNum(""); }}
                            style={{ padding: "6px 12px", borderRadius: 7, border: "1.5px solid #e0ddd4", background: "transparent", color: "#888", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                            Скинути ✕
                        </button>
                    )}
                </div>
            </div>

            {/* Підсумки по менеджерах */}
            {managersWithData.length > 0 && (
                <div style={{ background: "#fff", borderRadius: 10, padding: 20, marginBottom: 20, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "#1a1a14", marginBottom: 16 }}>Підсумки по менеджерах</div>
                    <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                            <thead>
                                <tr style={{ borderBottom: "1px solid #f0ece2" }}>
                                    <th rowSpan={2} style={{ textAlign: "left", padding: "8px 10px", color: "#888", fontWeight: 600, fontSize: 11, letterSpacing: 1, textTransform: "uppercase", verticalAlign: "bottom" }}>Менеджер</th>
                                    <th rowSpan={2} style={{ textAlign: "center", padding: "8px 10px", color: "#888", fontWeight: 600, fontSize: 11, letterSpacing: 1, textTransform: "uppercase", verticalAlign: "bottom" }}>Замовл.</th>
                                    <th colSpan={1} style={{ textAlign: "center", padding: "6px 10px", color: "#5a6a5a", fontWeight: 700, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", borderBottom: "1px solid #e0ece0", background: "#f5faf5" }}>Claude</th>
                                    <th colSpan={1} style={{ textAlign: "center", padding: "6px 10px", color: "#5a5a6a", fontWeight: 700, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", borderBottom: "1px solid #e0e0ec", background: "#f5f5fa" }}>Gemini</th>
                                    <th colSpan={2} style={{ textAlign: "center", padding: "6px 10px", color: "#6a4a1a", fontWeight: 700, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", borderBottom: "1px solid #e8d4a0", background: "#fdf8ee" }}>Serper</th>
                                    <th colSpan={1} style={{ textAlign: "center", padding: "6px 10px", color: "#888", fontWeight: 700, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", borderBottom: "1px solid #f0ece2" }}>Разом</th>
                                    <th rowSpan={2} style={{ textAlign: "center", padding: "6px 10px", color: "#888", fontWeight: 600, fontSize: 11, letterSpacing: 1, textTransform: "uppercase", verticalAlign: "bottom", whiteSpace: "nowrap" }}>Час</th>
                                </tr>
                                <tr style={{ borderBottom: "2px solid #f0ece2" }}>
                                    {["$","$","Кред.","$","$"].map((h, i) => (
                                        <th key={i} style={{ textAlign: "center", padding: "4px 8px", color: "#aaa", fontWeight: 600, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", whiteSpace: "nowrap" }}>{h}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {managersWithData.map((row, i) => (
                                    <tr key={row.uid} style={{ borderBottom: "1px solid #f0ece2", background: i % 2 === 0 ? "transparent" : "#faf8f3" }}>
                                        <td style={{ padding: "10px 10px" }}>
                                            <div style={{ fontWeight: 600, color: "#1a1a14" }}>{row.user?.name || "—"}</div>
                                            <div style={{ fontSize: 11, color: "#aaa" }}>{row.user?.email || row.uid}</div>
                                        </td>
                                        <td style={{ textAlign: "center", fontWeight: 700, color: "#1a1a14" }}>{row.count}</td>
                                        <td style={{ textAlign: "center", fontWeight: 600, color: "#1a6a1a", fontSize: 12 }}>{fmtCost(row.claudeCostUsd)}</td>
                                        <td style={{ textAlign: "center", fontWeight: 600, color: "#1a6a1a", fontSize: 12 }}>{fmtCost(row.geminiCostUsd)}</td>
                                        <td style={{ textAlign: "center", color: "#6a4a1a", fontFamily: "monospace", fontSize: 12 }}>{row.serperCredits || 0}</td>
                                        <td style={{ textAlign: "center", fontWeight: 600, color: "#6a4a1a", fontSize: 12 }}>{fmtCost(row.serperCostUsd)}</td>
                                        <td style={{ textAlign: "center", fontWeight: 700, color: "#1a6a1a" }}>{fmtCost(row.costUsd)}</td>
                                        <td style={{ textAlign: "center", color: "#555", fontFamily: "monospace", fontSize: 12, whiteSpace: "nowrap" }}>{fmtDur(row.durationSec)}</td>
                                    </tr>
                                ))}
                                <tr style={{ borderTop: "2px solid #1a1a14", background: "#1a1a14" }}>
                                    <td style={{ padding: "10px 10px", color: "#e8ff47", fontWeight: 700 }}>Всього</td>
                                    <td style={{ textAlign: "center", color: "#e8ff47", fontWeight: 700 }}>{orders.length}</td>
                                    <td style={{ textAlign: "center", color: "#e8ff47", fontWeight: 700 }}>{fmtCost(totals.grandClaudeCost)}</td>
                                    <td style={{ textAlign: "center", color: "#e8ff47", fontWeight: 700 }}>{fmtCost(totals.grandGeminiCost)}</td>
                                    <td style={{ textAlign: "center", color: "#e8c870", fontFamily: "monospace", fontSize: 12 }}>{totals.grandSerperCredits}</td>
                                    <td style={{ textAlign: "center", color: "#e8ff47", fontWeight: 700 }}>{fmtCost(totals.grandSerperCost)}</td>
                                    <td style={{ textAlign: "center", color: "#e8ff47", fontWeight: 700, fontSize: 15 }}>{fmtCost(totals.grandCost)}</td>
                                    <td style={{ textAlign: "center", color: "#e8ff47", fontWeight: 700, whiteSpace: "nowrap" }}>{fmtDur(totals.grandDurationSec)}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Таблиця по замовленнях */}
            <div style={{ background: "#fff", borderRadius: 10, padding: 20, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "#1a1a14" }}>
                        Замовлення з трекінгом токенів ({orders.length})
                    </div>
                    {orders.length > 0 && (
                        <button onClick={exportCSV}
                            style={{ padding: "7px 16px", borderRadius: 7, border: "1.5px solid #1a1a14", background: "transparent", color: "#1a1a14", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                            ↓ Експорт CSV
                        </button>
                    )}
                </div>
                {orders.length === 0 ? (
                    <div style={{ color: "#aaa", fontSize: 14 }}>Немає даних за вибраний період</div>
                ) : (
                    <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                            <thead>
                                <tr style={{ borderBottom: "1px solid #f0ece2" }}>
                                    <th rowSpan={2} style={{ textAlign: "left", padding: "8px 8px", color: "#888", fontWeight: 600, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", whiteSpace: "nowrap", verticalAlign: "bottom" }}>Дата</th>
                                    <th rowSpan={2} style={{ textAlign: "left", padding: "8px 8px", color: "#888", fontWeight: 600, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", verticalAlign: "bottom" }}>Менеджер</th>
                                    <th rowSpan={2} style={{ textAlign: "left", padding: "8px 8px", color: "#888", fontWeight: 600, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", whiteSpace: "nowrap", verticalAlign: "bottom" }}>№</th>
                                    <th rowSpan={2} style={{ textAlign: "left", padding: "8px 8px", color: "#888", fontWeight: 600, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", verticalAlign: "bottom" }}>Тема</th>
                                    <th rowSpan={2} style={{ textAlign: "left", padding: "8px 8px", color: "#888", fontWeight: 600, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", verticalAlign: "bottom", width: 100, maxWidth: 100 }}>Тип</th>
                                    <th rowSpan={2} style={{ textAlign: "center", padding: "8px 6px", color: "#888", fontWeight: 600, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", whiteSpace: "nowrap", verticalAlign: "bottom" }}>Стор.</th>
                                    <th colSpan={1} style={{ textAlign: "center", padding: "4px 8px", color: "#5a6a5a", fontWeight: 700, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", borderBottom: "1px solid #e0ece0", background: "#f5faf5" }}>Claude</th>
                                    <th colSpan={1} style={{ textAlign: "center", padding: "4px 8px", color: "#5a5a6a", fontWeight: 700, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", borderBottom: "1px solid #e0e0ec", background: "#f5f5fa" }}>Gemini</th>
                                    <th colSpan={2} style={{ textAlign: "center", padding: "4px 8px", color: "#6a4a1a", fontWeight: 700, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", borderBottom: "1px solid #e8d4a0", background: "#fdf8ee" }}>Serper</th>
                                    <th colSpan={1} style={{ textAlign: "center", padding: "4px 8px", color: "#888", fontWeight: 700, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", borderBottom: "1px solid #f0ece2" }}>Разом</th>
                                    <th rowSpan={2} style={{ textAlign: "center", padding: "8px 8px", color: "#888", fontWeight: 600, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", whiteSpace: "nowrap", verticalAlign: "bottom" }}>Час</th>
                                </tr>
                                <tr style={{ borderBottom: "2px solid #f0ece2" }}>
                                    {["$","$","Кред.","$","$"].map((h, i) => (
                                        <th key={i} style={{ textAlign: "center", padding: "4px 6px", color: "#aaa", fontWeight: 600, fontSize: 10, whiteSpace: "nowrap" }}>{h}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {orders.map((o, i) => {
                                    const u = userMap[o.uid];
                                    return (
                                        <tr key={o.id} style={{ borderBottom: "1px solid #f0ece2", background: i % 2 === 0 ? "transparent" : "#faf8f3" }}>
                                            <td style={{ padding: "9px 8px", color: "#888", fontSize: 11, whiteSpace: "nowrap" }}>{fmt(o.createdAt)}</td>
                                            <td style={{ padding: "9px 8px" }}>
                                                <div style={{ fontWeight: 600, color: "#1a1a14", fontSize: 12 }}>{u?.name || "—"}</div>
                                            </td>
                                            <td style={{ padding: "9px 8px", color: "#555", fontSize: 11, fontFamily: "monospace", whiteSpace: "nowrap" }}>{o.info?.orderNumber || "—"}</td>
                                            <td style={{ padding: "9px 8px", color: "#1a1a14", fontSize: 11, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={o.info?.topic || o.topic || ""}>{o.info?.topic || o.topic || "—"}</td>
                                            <td style={{ padding: "9px 8px", color: "#1a1a14", maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={o.type || o.workType || ""}>{o.type || o.workType || "—"}</td>
                                            <td style={{ textAlign: "center", padding: "9px 6px", color: "#555" }}>{o.pages || "—"}</td>
                                            <td style={{ textAlign: "center", padding: "9px 6px", fontWeight: 600, color: "#1a6a1a" }}>{fmtCost(o.claudeCostUsd)}</td>
                                            <td style={{ textAlign: "center", padding: "9px 6px", fontWeight: 600, color: "#1a6a1a" }}>{fmtCost(o.geminiCostUsd)}</td>
                                            <td style={{ textAlign: "center", padding: "9px 6px", color: "#6a4a1a", fontFamily: "monospace" }}>{o.serperCredits || 0}</td>
                                            <td style={{ textAlign: "center", padding: "9px 6px", fontWeight: 600, color: "#6a4a1a" }}>{fmtCost(o.serperCostUsd)}</td>
                                            <td style={{ textAlign: "center", padding: "9px 8px", fontWeight: 700, color: "#1a6a1a" }}>{fmtCost(o.totalCostUsd)}</td>
                                            <td style={{ textAlign: "center", padding: "9px 8px", color: "#555", fontFamily: "monospace", whiteSpace: "nowrap" }}>{fmtDur(o.generationDurationSec)}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── Вкладка логів входів ────────────────────────────────────────────────────

function parseUA(ua) {
    if (!ua) return "—";
    const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Інший";
    const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
    return os ? `${browser} / ${os}` : browser;
}

function LogsTab({ users }) {
    const [logs, setLogs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [filterUid, setFilterUid] = useState("all");

    useEffect(() => {
        const load = async () => {
            setLoading(true);
            const q = query(collection(db, "loginLogs"), orderBy("timestamp", "desc"), limit(300));
            const snap = await getDocs(q);
            setLogs(snap.docs.map(d => ({ id: d.id, ...d.data() })));
            setLoading(false);
        };
        load();
    }, []);

    const userMap = useMemo(() => {
        const m = {};
        users.forEach(u => { m[u.id] = u; });
        return m;
    }, [users]);

    const filtered = filterUid === "all" ? logs : logs.filter(l => l.uid === filterUid);

    const fmtTime = (iso) => {
        if (!iso) return "—";
        return new Date(iso).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
    };

    return (
        <div>
            <div style={{ background: "#fff", borderRadius: 10, padding: "16px 20px", marginBottom: 20, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                <div style={{ fontSize: 11, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 10 }}>Фільтр</div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <select value={filterUid} onChange={e => setFilterUid(e.target.value)}
                        style={{ padding: "6px 10px", border: "1.5px solid #e0ddd4", borderRadius: 7, fontSize: 13, fontFamily: "inherit", background: "#fff" }}>
                        <option value="all">Всі менеджери</option>
                        {users.map(u => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
                    </select>
                    {filterUid !== "all" && (
                        <button onClick={() => setFilterUid("all")}
                            style={{ padding: "6px 12px", borderRadius: 7, border: "1.5px solid #e0ddd4", background: "transparent", color: "#888", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                            Скинути ✕
                        </button>
                    )}
                    <span style={{ fontSize: 12, color: "#bbb", marginLeft: 4 }}>{filtered.length} записів</span>
                </div>
            </div>

            <div style={{ background: "#fff", borderRadius: 10, padding: 20, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#1a1a14", marginBottom: 16 }}>Логи входів</div>
                {loading ? (
                    <div style={{ color: "#888", fontSize: 14 }}>Завантаження...</div>
                ) : filtered.length === 0 ? (
                    <div style={{ color: "#aaa", fontSize: 14 }}>Немає записів</div>
                ) : (
                    <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                            <thead>
                                <tr style={{ borderBottom: "2px solid #f0ece2" }}>
                                    <th style={{ textAlign: "left", padding: "8px 10px", color: "#888", fontWeight: 600, fontSize: 11, letterSpacing: 1, textTransform: "uppercase" }}>Менеджер</th>
                                    <th style={{ textAlign: "left", padding: "8px 10px", color: "#888", fontWeight: 600, fontSize: 11, letterSpacing: 1, textTransform: "uppercase", whiteSpace: "nowrap" }}>Дата і час</th>
                                    <th style={{ textAlign: "left", padding: "8px 10px", color: "#888", fontWeight: 600, fontSize: 11, letterSpacing: 1, textTransform: "uppercase" }}>Браузер / ОС</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filtered.map((log, i) => {
                                    const u = userMap[log.uid];
                                    return (
                                        <tr key={log.id} style={{ borderBottom: "1px solid #f0ece2", background: i % 2 === 0 ? "transparent" : "#faf8f3" }}>
                                            <td style={{ padding: "10px 10px" }}>
                                                <div style={{ fontWeight: 600, color: "#1a1a14" }}>{u?.name || "—"}</div>
                                                <div style={{ fontSize: 11, color: "#aaa" }}>{log.email || u?.email || log.uid}</div>
                                            </td>
                                            <td style={{ padding: "10px 10px", color: "#555", whiteSpace: "nowrap" }}>{fmtTime(log.timestamp)}</td>
                                            <td style={{ padding: "10px 10px", color: "#555" }}>{parseUA(log.userAgent)}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── Результати тестів (адмін) ────────────────────────────────────────────────

function AdminTestResults() {
    const [results, setResults] = useState([]);
    const [usersMap, setUsersMap] = useState({});
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const load = async () => {
            try {
                const [resultsSnap, usersSnap] = await Promise.all([
                    getDocs(collection(db, "training_results")),
                    getDocs(collection(db, "users")),
                ]);
                setResults(resultsSnap.docs.map(d => ({ id: d.id, ...d.data() })));
                const um = {};
                usersSnap.docs.forEach(d => { um[d.id] = d.data(); });
                setUsersMap(um);
            } finally {
                setLoading(false);
            }
        };
        load();
    }, []);

    const fmtTime = (iso) => iso
        ? new Date(iso).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
        : "—";

    return (
        <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 16px" }}>
            <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: 2, color: "#1a1a14", marginBottom: 20, textTransform: "uppercase" }}>
                Результати проходження тестів
            </div>
            {loading ? (
                <div style={{ color: "#aaa", padding: 32, textAlign: "center" }}>Завантаження...</div>
            ) : results.length === 0 ? (
                <div style={{ background: "#fff", borderRadius: 12, padding: 32, textAlign: "center", boxShadow: "0 2px 12px rgba(0,0,0,0.06)", color: "#aaa", fontSize: 14 }}>
                    Ще ніхто не проходив тести
                </div>
            ) : (
                <div style={{ background: "#fff", borderRadius: 12, padding: 20, boxShadow: "0 2px 12px rgba(0,0,0,0.06)", overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead>
                            <tr style={{ borderBottom: "2px solid #f0ece2" }}>
                                {["Менеджер", "Тест", "Результат", "Спроба", "Дата"].map(h => (
                                    <th key={h} style={{ textAlign: h === "Результат" || h === "Спроба" ? "center" : "left", padding: "8px 12px", color: "#888", fontWeight: 600, fontSize: 11, letterSpacing: 1, textTransform: "uppercase", whiteSpace: "nowrap" }}>{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {results
                                .sort((a, b) => (b.submittedAt || "").localeCompare(a.submittedAt || ""))
                                .map((r, i) => {
                                    const u = usersMap[r.userId];
                                    return (
                                        <tr key={r.id} style={{ borderBottom: "1px solid #f0ece2", background: i % 2 === 0 ? "transparent" : "#faf8f3" }}>
                                            <td style={{ padding: "10px 12px" }}>
                                                <div style={{ fontWeight: 600, color: "#1a1a14" }}>{u?.name || r.userName || "—"}</div>
                                                <div style={{ fontSize: 11, color: "#aaa" }}>{u?.email || r.userEmail}</div>
                                            </td>
                                            <td style={{ padding: "10px 12px", color: "#555" }}>{r.testTitle}</td>
                                            <td style={{ textAlign: "center", padding: "10px 12px" }}>
                                                <span style={{ fontWeight: 700, color: r.passed ? "#1a6a1a" : "#c00" }}>
                                                    {r.score}/{r.total}
                                                </span>
                                                <span style={{ marginLeft: 8, fontSize: 11, padding: "2px 8px", borderRadius: 10, fontWeight: 600, background: r.passed ? "#e4ffe4" : "#fff3e0", color: r.passed ? "#1a6a1a" : "#8a5a1a" }}>
                                                    {r.passed ? "Пройдено" : "Не пройдено"}
                                                </span>
                                            </td>
                                            <td style={{ textAlign: "center", padding: "10px 12px", color: "#888" }}>{r.attempt}</td>
                                            <td style={{ padding: "10px 12px", color: "#888", fontSize: 12, whiteSpace: "nowrap" }}>{fmtTime(r.submittedAt)}</td>
                                        </tr>
                                    );
                                })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

// ─── Головна сторінка ─────────────────────────────────────────────────────────

export default function AdminPage({ onBack }) {
    const { user: currentUser } = useAuth();
    const [tab, setTab] = useState("users");
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [newEmail, setNewEmail] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [newName, setNewName] = useState("");
    const [newRole, setNewRole] = useState("manager");
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");

    const loadUsers = async () => {
        setLoading(true);
        const snap = await getDocs(collection(db, "users"));
        setUsers(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        setLoading(false);
    };

    useEffect(() => { loadUsers(); }, []);

    const createUser = async (e) => {
        e.preventDefault();
        setError(""); setSuccess(""); setCreating(true);
        try {
            const secondaryApp = initializeApp(
                JSON.parse(document.getElementById("fb-config").textContent),
                "secondary-" + Date.now()
            );
            const secondaryAuth = getAuth(secondaryApp);
            const cred = await createUserWithEmailAndPassword(secondaryAuth, newEmail, newPassword);

            await setDoc(doc(db, "users", cred.user.uid), {
                email: newEmail,
                name: newName,
                role: newRole,
                approved: true,
                blocked: false,
                createdAt: new Date().toISOString(),
            });

            await deleteApp(secondaryApp);

            setSuccess(`✓ Користувача ${newEmail} створено з роллю "${ROLE_LABELS[newRole]?.label}"!`);
            setNewEmail(""); setNewPassword(""); setNewName(""); setNewRole("manager");
            loadUsers();
        } catch (e) {
            setError(e.message);
        }
        setCreating(false);
    };

    const toggleBlock = async (uid, blocked) => {
        await updateDoc(doc(db, "users", uid), { blocked: !blocked });
        loadUsers();
    };

    const changeRole = async (uid, currentRole) => {
        const next = currentRole === "user" ? "manager" : currentRole === "manager" ? "admin" : "manager";
        if (!window.confirm(`Змінити роль на "${ROLE_LABELS[next]?.label}"?`)) return;
        await updateDoc(doc(db, "users", uid), { role: next });
        loadUsers();
    };

    const deleteUser = async (uid) => {
        if (!window.confirm("Видалити користувача?")) return;
        await deleteDoc(doc(db, "users", uid));
        loadUsers();
    };

    return (
        <div style={{ minHeight: "100vh", background: "#f5f2eb", fontFamily: "'Georgia', serif" }}>
            <div style={{ background: "#1a1a14", color: "#e8ff47", padding: "16px 32px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: 3 }}>ACADEM — Адмін-панель</div>
                <button onClick={onBack} style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "6px 16px", cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>← Назад</button>
            </div>

            <div style={{ maxWidth: 960, margin: "32px auto", padding: "0 20px" }}>

                {/* Вкладки */}
                <div style={{ display: "flex", gap: 4, marginBottom: 24, borderBottom: "2px solid #e0ddd4" }}>
                    {[
                        { key: "users", label: "Користувачі" },
                        { key: "stats", label: "Статистика" },
                        { key: "costs", label: "Витрати" },
                        { key: "logs", label: "Логи входів" },
                        { key: "tests", label: "Тести" },
                    ].map(t => (
                        <button key={t.key} onClick={() => setTab(t.key)}
                            style={{
                                padding: "10px 22px", fontSize: 14, fontWeight: tab === t.key ? 700 : 400,
                                background: "transparent", border: "none", cursor: "pointer",
                                fontFamily: "inherit", color: tab === t.key ? "#1a1a14" : "#888",
                                borderBottom: tab === t.key ? "2px solid #1a1a14" : "2px solid transparent",
                                marginBottom: -2, transition: "all .15s",
                            }}>
                            {t.label}
                        </button>
                    ))}
                </div>

                {/* Вкладка: Користувачі */}
                {tab === "users" && (
                    <>
                        {/* Створити користувача */}
                        <div style={{ background: "#fff", borderRadius: 10, padding: 24, marginBottom: 24, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16, color: "#1a1a14" }}>Створити нового користувача</div>
                            <form onSubmit={createUser}>
                                <AdminField label="Ім'я" value={newName} onChange={setNewName} placeholder="Іван Петренко" />
                                <AdminField label="Email" value={newEmail} onChange={setNewEmail} type="email" placeholder="user@example.com" />
                                <AdminField label="Пароль" value={newPassword} onChange={setNewPassword} type="password" placeholder="мінімум 6 символів" />

                                <div style={{ marginBottom: 16 }}>
                                    <div style={{ fontSize: 11, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>Роль</div>
                                    <div style={{ display: "flex", gap: 10 }}>
                                        {[
                                            { key: "user", label: "Стажер", desc: "Тільки навчання, без замовлень" },
                                            { key: "manager", label: "Менеджер", desc: "Створює та редагує замовлення" },
                                            { key: "admin", label: "Адмін", desc: "Повний доступ + адмін-панель" },
                                        ].map(r => (
                                            <div key={r.key} onClick={() => setNewRole(r.key)}
                                                style={{
                                                    flex: 1, padding: "12px 16px", borderRadius: 8, cursor: "pointer",
                                                    border: `2px solid ${newRole === r.key ? "#1a1a14" : "#e0ddd4"}`,
                                                    background: newRole === r.key ? "#1a1a14" : "#faf8f3",
                                                    transition: "all .15s",
                                                }}>
                                                <div style={{ fontSize: 13, fontWeight: 700, color: newRole === r.key ? "#e8ff47" : "#1a1a14", marginBottom: 3 }}>{r.label}</div>
                                                <div style={{ fontSize: 11, color: newRole === r.key ? "#aaa" : "#888" }}>{r.desc}</div>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                {error && <div style={{ color: "#c00", fontSize: 13, marginBottom: 12, background: "#fff0f0", padding: "8px 12px", borderRadius: 6 }}>{error}</div>}
                                {success && <div style={{ color: "#060", fontSize: 13, marginBottom: 12, background: "#f0fff0", padding: "8px 12px", borderRadius: 6 }}>{success}</div>}
                                <button type="submit" disabled={creating}
                                    style={{ background: creating ? "#aaa" : "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 7, padding: "10px 28px", fontSize: 13, fontWeight: 700, cursor: creating ? "default" : "pointer" }}>
                                    {creating ? "Створюю..." : "Створити →"}
                                </button>
                            </form>
                        </div>

                        {/* Список користувачів */}
                        <div style={{ background: "#fff", borderRadius: 10, padding: 24, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16, color: "#1a1a14" }}>
                                Користувачі ({users.length})
                            </div>
                            {loading ? (
                                <div style={{ color: "#888" }}>Завантаження...</div>
                            ) : users.length === 0 ? (
                                <div style={{ color: "#aaa", fontSize: 14 }}>Поки немає користувачів</div>
                            ) : users.map(u => {
                                const roleInfo = ROLE_LABELS[u.role] || ROLE_LABELS.user;
                                return (
                                    <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 0", borderBottom: "1px solid #f0ece2" }}>
                                        <div style={{ width: 38, height: 38, borderRadius: "50%", background: u.blocked ? "#ffeeee" : u.role === "user" ? "#fdf9e8" : "#eef5e4", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>
                                            {u.blocked ? "🚫" : u.role === "admin" ? "👑" : u.role === "user" ? "📚" : "👤"}
                                        </div>

                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontSize: 14, fontWeight: 600, color: "#1a1a14" }}>{u.name || "—"}</div>
                                            <div style={{ fontSize: 12, color: "#888", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.email}</div>
                                        </div>

                                        <div style={{ padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 600, background: roleInfo.bg, color: roleInfo.color, flexShrink: 0 }}>
                                            {roleInfo.label}
                                        </div>

                                        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                                            {u.id === currentUser?.uid && (
                                                <span style={{ fontSize: 11, color: "#aaa", padding: "5px 10px", fontStyle: "italic" }}>це ви</span>
                                            )}
                                            {u.id !== currentUser?.uid && u.role === "user" && (
                                                <button onClick={() => changeRole(u.id, u.role)}
                                                    style={{ background: "#eef5e4", border: "1px solid #c8dfa0", color: "#3a6010", borderRadius: 6, padding: "5px 10px", fontSize: 11, cursor: "pointer" }}>
                                                    → Менеджер
                                                </button>
                                            )}
                                            {u.id !== currentUser?.uid && u.role === "manager" && (
                                                <button onClick={() => changeRole(u.id, u.role)}
                                                    style={{ background: "#f0f5ff", border: "1px solid #c0d0f0", color: "#1a5a8a", borderRadius: 6, padding: "5px 10px", fontSize: 11, cursor: "pointer" }}>
                                                    → Адмін
                                                </button>
                                            )}
                                            {u.id !== currentUser?.uid && u.role === "admin" && (
                                                <button onClick={() => changeRole(u.id, u.role)}
                                                    style={{ background: "#f5e4ff", border: "1px solid #d0a0f0", color: "#8a1a8a", borderRadius: 6, padding: "5px 10px", fontSize: 11, cursor: "pointer" }}>
                                                    → Менеджер
                                                </button>
                                            )}

                                            {u.id !== currentUser?.uid && (
                                                <button onClick={() => toggleBlock(u.id, u.blocked)}
                                                    style={{ background: u.blocked ? "#eef5e4" : "#fff0f0", border: `1px solid ${u.blocked ? "#c8dfa0" : "#ffcccc"}`, color: u.blocked ? "#3a6010" : "#c00", borderRadius: 6, padding: "5px 10px", fontSize: 11, cursor: "pointer" }}>
                                                    {u.blocked ? "Розблок." : "Блок."}
                                                </button>
                                            )}

                                            {u.id !== currentUser?.uid && (
                                                <button onClick={() => deleteUser(u.id)}
                                                    style={{ background: "transparent", border: "1px solid #ddd", color: "#aaa", borderRadius: 6, padding: "5px 10px", fontSize: 11, cursor: "pointer" }}
                                                    onMouseEnter={e => { e.currentTarget.style.borderColor = "#f99"; e.currentTarget.style.color = "#c55"; }}
                                                    onMouseLeave={e => { e.currentTarget.style.borderColor = "#ddd"; e.currentTarget.style.color = "#aaa"; }}>
                                                    ✕
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </>
                )}

                {/* Вкладка: Статистика */}
                {tab === "stats" && <StatsTab users={users} />}

                {/* Вкладка: Витрати */}
                {tab === "costs" && <CostsTab users={users} />}

                {/* Вкладка: Логи входів */}
                {tab === "logs" && <LogsTab users={users} />}

                {/* Вкладка: Тести */}
                {tab === "tests" && <AdminTestResults />}
            </div>
        </div>
    );
}
