import { useState, useEffect, useRef } from "react";
import { db } from "./firebase";
import { collection, getDocs, addDoc, setDoc, deleteDoc, doc, query, orderBy, where } from "firebase/firestore";
import { useAuth } from "./AuthContext";

function genId() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

export default function TrainingTests({ onBack }) {
    const { user, profile } = useAuth();
    const isAdmin = profile?.role === "admin";

    const [tests, setTests] = useState([]);
    const [loading, setLoading] = useState(true);
    const [activeTest, setActiveTest] = useState(null);
    const [answers, setAnswers] = useState({});
    const [shuffledRights, setShuffledRights] = useState({});
    const [submitted, setSubmitted] = useState(false);
    const [score, setScore] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [myResults, setMyResults] = useState([]);
    const [editingTest, setEditingTest] = useState(null);
    const [saving, setSaving] = useState(false);
    const [dragOver, setDragOver] = useState({ qi: null, idx: null });

    const dragItem = useRef(null);

    useEffect(() => {
        loadTests();
        loadMyResults();
    }, []);


    const loadTests = async () => {
        setLoading(true);
        try {
            const snap = await getDocs(query(collection(db, "training_tests"), orderBy("order")));
            setTests(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        } finally {
            setLoading(false);
        }
    };

    const loadMyResults = async () => {
        const snap = await getDocs(query(collection(db, "training_results"), where("userId", "==", user.uid)));
        setMyResults(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    };


    // ── Test-taking logic ──────────────────────────────────────────────────────

    const startTest = (test) => {
        setActiveTest(test);
        const initialAnswers = {};
        const sr = {};
        (test.questions || []).forEach((q, qi) => {
            if (q.type === "order") {
                initialAnswers[qi] = shuffle([...(q.items || [])]);
            }
            if (q.type === "match") {
                sr[qi] = shuffle((q.pairs || []).map(p => p.right));
            }
        });
        setAnswers(initialAnswers);
        setShuffledRights(sr);
        setSubmitted(false);
        setScore(null);
    };

    const isQuestionCorrect = (q, qi) => {
        if (q.type === "match") {
            const ans = answers[qi] || {};
            return (q.pairs || []).every((pair, pi) => ans[pi] === pair.right);
        }
        if (q.type === "order") {
            return JSON.stringify(answers[qi]) === JSON.stringify(q.items);
        }
        if (q.type === "multi") {
            const selected = [...(answers[qi] || [])].sort().join(",");
            const correct = [...(q.correct || [])].sort().join(",");
            return selected === correct;
        }
        return answers[qi] === q.correct;
    };

    const submitTest = async () => {
        if (!activeTest) return;
        const total = activeTest.questions?.length || 0;
        const correct = (activeTest.questions || []).filter((q, qi) => isQuestionCorrect(q, qi)).length;
        setSubmitting(true);
        // Show results immediately so UI never blocks on Firebase
        setScore({ correct, total });
        setSubmitted(true);
        setSubmitting(false);
        try {
            const prevAttempts = myResults.filter(r => r.testId === activeTest.id);
            await addDoc(collection(db, "training_results"), {
                userId: user.uid,
                userEmail: user.email,
                userName: profile?.name || user.email,
                testId: activeTest.id,
                testTitle: activeTest.title,
                answers: (activeTest.questions || []).map((_, i) => {
                    const ans = answers[i] ?? null;
                    return Array.isArray(ans) ? JSON.stringify(ans) : ans;
                }),
                score: correct,
                total,
                passed: correct === total,
                submittedAt: new Date().toISOString(),
                attempt: prevAttempts.length + 1,
            });
            await loadMyResults();
        } catch (e) { console.error("Помилка збереження результату:", e); }
    };

    const getBestResult = (testId) => {
        const r = myResults.filter(r => r.testId === testId);
        return r.length ? r.reduce((best, cur) => cur.score > best.score ? cur : best) : null;
    };

    const allAnswered = activeTest ? (activeTest.questions || []).every((q, qi) => {
        if (q.type === "match") {
            const ans = answers[qi] || {};
            return (q.pairs || []).every((_, pi) => ans[pi] !== undefined && ans[pi] !== "");
        }
        if (q.type === "order") return true;
        if (q.type === "multi") return (answers[qi] || []).length > 0;
        return answers[qi] !== undefined;
    }) : false;

    // Drag-and-drop for order questions
    const handleDragStart = (qi, idx) => {
        dragItem.current = { qi, idx };
    };

    const handleDragOver = (e, qi, idx) => {
        e.preventDefault();
        setDragOver({ qi, idx });
    };

    const handleDrop = (qi, toIdx) => {
        if (!dragItem.current || dragItem.current.qi !== qi) return;
        const fromIdx = dragItem.current.idx;
        if (fromIdx === toIdx) { dragItem.current = null; setDragOver({ qi: null, idx: null }); return; }
        setAnswers(p => {
            const arr = [...(p[qi] || [])];
            const [removed] = arr.splice(fromIdx, 1);
            arr.splice(toIdx, 0, removed);
            return { ...p, [qi]: arr };
        });
        dragItem.current = null;
        setDragOver({ qi: null, idx: null });
    };

    const handleDragEnd = () => {
        dragItem.current = null;
        setDragOver({ qi: null, idx: null });
    };

    // ── Test editor logic ──────────────────────────────────────────────────────

    const startNewTest = () => {
        setEditingTest({
            _new: true,
            id: genId(),
            title: "",
            order: tests.length + 1,
            questions: [],
        });
    };

    const startEditTest = (test) => {
        setEditingTest(JSON.parse(JSON.stringify(test)));
    };

    const saveTest = async () => {
        if (!editingTest.title.trim()) return alert("Введіть назву тесту");
        if (editingTest.questions.length === 0) return alert("Додайте хоча б одне питання");
        for (const q of editingTest.questions) {
            if (!q.text.trim()) return alert("Заповніть текст усіх питань");
            if (q.type === "match") {
                if (!q.pairs || q.pairs.length < 2) return alert("Додайте хоча б 2 пари для питання «З'єднай»");
                if (q.pairs.some(p => !p.left.trim() || !p.right.trim())) return alert("Заповніть усі пари у питанні «З'єднай»");
            } else if (q.type === "order") {
                if (!q.items || q.items.length < 2) return alert("Додайте хоча б 2 елементи для питання «По порядку»");
                if (q.items.some(item => !item.trim())) return alert("Заповніть усі елементи у питанні «По порядку»");
            } else if (q.type === "multi") {
                if (q.options.some(o => !o.trim())) return alert("Заповніть усі варіанти відповідей");
                if (!q.correct || q.correct.length === 0) return alert("Відмітьте хоча б одну правильну відповідь");
            } else {
                if (q.options.some(o => !o.trim())) return alert("Заповніть усі варіанти відповідей");
            }
        }
        setSaving(true);
        try {
            const { _new, id, ...data } = editingTest;
            if (_new) {
                await addDoc(collection(db, "training_tests"), data);
            } else {
                await setDoc(doc(db, "training_tests", id), data);
            }
            await loadTests();
            setEditingTest(null);
        } catch (e) { console.error(e); }
        setSaving(false);
    };

    const deleteTest = async (testId) => {
        if (!window.confirm("Видалити тест? Результати збережуться.")) return;
        await deleteDoc(doc(db, "training_tests", testId));
        await loadTests();
    };

    // Edit helpers — common
    const updTest = (patch) => setEditingTest(p => ({ ...p, ...patch }));

    const addQuestion = (type = "radio") => {
        let q;
        if (type === "match") q = { id: genId(), type: "match", text: "", pairs: [{ left: "", right: "" }, { left: "", right: "" }] };
        else if (type === "order") q = { id: genId(), type: "order", text: "", items: ["", "", ""] };
        else if (type === "multi") q = { id: genId(), type: "multi", text: "", options: ["", "", "", ""], correct: [] };
        else q = { id: genId(), type: "radio", text: "", options: ["", "", "", ""], correct: 0 };
        setEditingTest(p => ({ ...p, questions: [...p.questions, q] }));
    };

    const rmQuestion = (qi) => setEditingTest(p => ({
        ...p, questions: p.questions.filter((_, i) => i !== qi),
    }));

    const updQuestion = (qi, patch) => setEditingTest(p => ({
        ...p, questions: p.questions.map((q, i) => i !== qi ? q : { ...q, ...patch }),
    }));

    const setQuestionType = (qi, type) => setEditingTest(p => ({
        ...p,
        questions: p.questions.map((q, i) => {
            if (i !== qi) return q;
            if (type === "match") return { id: q.id, type: "match", text: q.text, pairs: [{ left: "", right: "" }, { left: "", right: "" }] };
            if (type === "order") return { id: q.id, type: "order", text: q.text, items: ["", "", ""] };
            if (type === "multi") return { id: q.id, type: "multi", text: q.text, options: ["", "", "", ""], correct: [] };
            return { id: q.id, type: "radio", text: q.text, options: ["", "", "", ""], correct: 0 };
        }),
    }));

    const moveQuestion = (qi, dir) => setEditingTest(p => {
        const qs = [...p.questions];
        const t = qi + dir;
        if (t < 0 || t >= qs.length) return p;
        [qs[qi], qs[t]] = [qs[t], qs[qi]];
        return { ...p, questions: qs };
    });

    // Edit helpers — radio / multi options
    const updOption = (qi, oi, value) => setEditingTest(p => ({
        ...p, questions: p.questions.map((q, i) => i !== qi ? q : {
            ...q, options: q.options.map((o, j) => j !== oi ? o : value),
        }),
    }));

    const addOption = (qi) => setEditingTest(p => ({
        ...p, questions: p.questions.map((q, i) => i !== qi ? q : {
            ...q, options: [...q.options, ""],
        }),
    }));

    const rmOption = (qi, oi) => setEditingTest(p => ({
        ...p, questions: p.questions.map((q, i) => {
            if (i !== qi) return q;
            const options = q.options.filter((_, j) => j !== oi);
            const correct = q.correct === oi ? 0 : q.correct > oi ? q.correct - 1 : q.correct;
            return { ...q, options, correct: Math.min(correct, options.length - 1) };
        }),
    }));

    const rmOptionMulti = (qi, oi) => setEditingTest(p => ({
        ...p, questions: p.questions.map((q, i) => {
            if (i !== qi) return q;
            const options = q.options.filter((_, j) => j !== oi);
            const correct = (q.correct || []).filter(c => c !== oi).map(c => c > oi ? c - 1 : c);
            return { ...q, options, correct };
        }),
    }));

    // Edit helpers — match
    const addPair = (qi) => setEditingTest(p => ({
        ...p, questions: p.questions.map((q, i) => i !== qi ? q : {
            ...q, pairs: [...q.pairs, { left: "", right: "" }],
        }),
    }));

    const rmPair = (qi, pi) => setEditingTest(p => ({
        ...p, questions: p.questions.map((q, i) => i !== qi ? q : {
            ...q, pairs: q.pairs.filter((_, j) => j !== pi),
        }),
    }));

    const updPair = (qi, pi, side, value) => setEditingTest(p => ({
        ...p, questions: p.questions.map((q, i) => i !== qi ? q : {
            ...q, pairs: q.pairs.map((pair, j) => j !== pi ? pair : { ...pair, [side]: value }),
        }),
    }));

    // Edit helpers — order
    const updItem = (qi, ii, value) => setEditingTest(p => ({
        ...p, questions: p.questions.map((q, i) => i !== qi ? q : {
            ...q, items: q.items.map((item, j) => j !== ii ? item : value),
        }),
    }));

    const addItem = (qi) => setEditingTest(p => ({
        ...p, questions: p.questions.map((q, i) => i !== qi ? q : {
            ...q, items: [...q.items, ""],
        }),
    }));

    const rmItem = (qi, ii) => setEditingTest(p => ({
        ...p, questions: p.questions.map((q, i) => i !== qi ? q : {
            ...q, items: q.items.filter((_, j) => j !== ii),
        }),
    }));

    const moveItem = (qi, ii, dir) => setEditingTest(p => ({
        ...p, questions: p.questions.map((q, i) => {
            if (i !== qi) return q;
            const items = [...q.items];
            const t = ii + dir;
            if (t < 0 || t >= items.length) return q;
            [items[ii], items[t]] = [items[t], items[ii]];
            return { ...q, items };
        }),
    }));

    // ── Styles ─────────────────────────────────────────────────────────────────

    const fmtTime = (iso) => iso
        ? new Date(iso).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
        : "—";

    const headerBtn = { background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontFamily: "inherit", fontSize: 12 };
    const primBtn = { background: "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 6, padding: "8px 22px", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700 };
    const miniBtn = { background: "transparent", border: "1px solid #ddd", borderRadius: 4, padding: "3px 8px", fontSize: 11, cursor: "pointer", color: "#666", fontFamily: "inherit" };
    const typeTabBase = { border: "1.5px solid #e0ddd4", borderRadius: 6, padding: "4px 10px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", fontWeight: 600, transition: "all .15s", whiteSpace: "nowrap" };

    // ── Render ─────────────────────────────────────────────────────────────────

    return (
        <div style={{ minHeight: "100vh", background: "#f5f2eb", fontFamily: "Georgia, serif" }}>
            {/* Header */}
            <div style={{ background: "#1a1a14", color: "#e8ff47", padding: "14px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20, flexWrap: "wrap" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                    <button onClick={editingTest ? () => { if (window.confirm("Скасувати редагування?")) setEditingTest(null); } : activeTest ? () => setActiveTest(null) : onBack}
                        style={headerBtn}>
                        {editingTest ? "✕ Скасувати" : activeTest ? "← До списку" : "← Навчання"}
                    </button>
                    <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: 3 }}>ACADEM — ТЕСТИ</span>
                </div>
                {isAdmin && !activeTest && !editingTest && (
                    <button onClick={startNewTest}
                        style={{ background: "#e8ff47", color: "#1a1a14", border: "none", borderRadius: 6, padding: "7px 18px", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700 }}>
                        + Новий тест
                    </button>
                )}
                {editingTest && (
                    <button onClick={saveTest} disabled={saving}
                        style={{ background: saving ? "#555" : "#e8ff47", color: "#1a1a14", border: "none", borderRadius: 6, padding: "7px 20px", cursor: saving ? "default" : "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700, opacity: saving ? 0.7 : 1 }}>
                        {saving ? "Збереження..." : "Зберегти тест"}
                    </button>
                )}
            </div>

            <div style={{ maxWidth: 800, margin: "0 auto", padding: "32px 20px" }}>

                {/* ── TEST EDITOR ── */}
                {editingTest ? (
                    <div style={{ background: "#fff", borderRadius: 12, padding: 32, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                        <div style={{ fontSize: 13, color: "#888", marginBottom: 20, fontStyle: "italic" }}>
                            {editingTest._new ? "Новий тест" : `Редагування: ${editingTest.title}`}
                        </div>

                        {/* Test title */}
                        <div style={{ marginBottom: 32 }}>
                            <div style={{ fontSize: 11, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6, fontFamily: "inherit" }}>Назва тесту</div>
                            <input
                                value={editingTest.title}
                                onChange={e => updTest({ title: e.target.value })}
                                placeholder="Наприклад: Тест — Основи роботи"
                                style={{ width: "100%", fontSize: 18, fontWeight: 700, fontFamily: "Georgia, serif", border: "none", borderBottom: "2px solid #e0ddd4", background: "transparent", padding: "6px 0", outline: "none", color: "#1a1a14", boxSizing: "border-box" }}
                            />
                        </div>

                        {/* Questions */}
                        {editingTest.questions.length === 0 && (
                            <div style={{ color: "#aaa", fontSize: 14, fontStyle: "italic", textAlign: "center", padding: "24px 0" }}>
                                Питань ще немає. Додайте перше питання.
                            </div>
                        )}

                        {editingTest.questions.map((q, qi) => (
                            <div key={q.id} style={{ border: "1.5px solid #e0ddd4", borderRadius: 10, padding: 20, marginBottom: 16, background: "#faf8f3" }}>
                                {/* Question header */}
                                <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                                    <span style={{ fontSize: 11, color: "#888", background: "#f0ece2", padding: "4px 10px", borderRadius: 4, textTransform: "uppercase", letterSpacing: 1, fontFamily: "inherit", flexShrink: 0, marginTop: 2 }}>
                                        {qi + 1}
                                    </span>
                                    {/* Type switcher */}
                                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", flex: 1 }}>
                                        {[
                                            { value: "radio", label: "Один варіант" },
                                            { value: "multi", label: "Декілька варіантів" },
                                            { value: "match", label: "З'єднай" },
                                            { value: "order", label: "По порядку" },
                                        ].map(({ value, label }) => (
                                            <button key={value} onClick={() => setQuestionType(qi, value)}
                                                style={{
                                                    ...typeTabBase,
                                                    background: q.type === value ? "#1a1a14" : "transparent",
                                                    color: q.type === value ? "#e8ff47" : "#888",
                                                    borderColor: q.type === value ? "#1a1a14" : "#e0ddd4",
                                                }}>
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                    <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                                        {qi > 0 && <button onClick={() => moveQuestion(qi, -1)} style={miniBtn}>↑</button>}
                                        {qi < editingTest.questions.length - 1 && <button onClick={() => moveQuestion(qi, 1)} style={miniBtn}>↓</button>}
                                        <button onClick={() => { if (window.confirm("Видалити питання?")) rmQuestion(qi); }} style={{ ...miniBtn, color: "#c00", borderColor: "#ffcccc" }}>✕</button>
                                    </div>
                                </div>

                                {/* Question text */}
                                <textarea
                                    value={q.text}
                                    onChange={e => updQuestion(qi, { text: e.target.value })}
                                    placeholder="Текст питання..."
                                    rows={2}
                                    style={{ width: "100%", padding: "8px 10px", border: "1.5px solid #e0ddd4", borderRadius: 6, fontSize: 14, fontFamily: "Georgia, serif", resize: "vertical", boxSizing: "border-box", lineHeight: 1.6, outline: "none", marginBottom: 14 }}
                                />

                                {/* ── Radio options editor ── */}
                                {q.type === "radio" && (
                                    <>
                                        <div style={{ fontSize: 11, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8, fontFamily: "inherit" }}>
                                            Варіанти — відмітьте правильний
                                        </div>
                                        {q.options.map((opt, oi) => (
                                            <div key={oi} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                                                <input type="radio" name={`correct-${q.id}`} checked={q.correct === oi}
                                                    onChange={() => updQuestion(qi, { correct: oi })}
                                                    style={{ accentColor: "#1a6a1a", width: 16, height: 16, flexShrink: 0, cursor: "pointer" }} />
                                                <input value={opt} onChange={e => updOption(qi, oi, e.target.value)}
                                                    placeholder={`Варіант ${oi + 1}`}
                                                    style={{ flex: 1, padding: "7px 10px", borderRadius: 6, fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box", border: `1.5px solid ${q.correct === oi ? "#8ac040" : "#e0ddd4"}`, background: q.correct === oi ? "#f0fff0" : "#fff" }} />
                                                {q.options.length > 2 && (
                                                    <button onClick={() => rmOption(qi, oi)} style={{ ...miniBtn, color: "#c00", borderColor: "#ffcccc", flexShrink: 0 }}>✕</button>
                                                )}
                                            </div>
                                        ))}
                                        {q.options.length < 6 && (
                                            <button onClick={() => addOption(qi)} style={{ background: "transparent", border: "1.5px dashed #ccc", borderRadius: 6, padding: "5px 14px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", color: "#888", marginTop: 4 }}>
                                                + Варіант
                                            </button>
                                        )}
                                        <div style={{ fontSize: 11, color: "#8ac040", marginTop: 10, fontStyle: "italic" }}>
                                            Правильна відповідь: {q.options[q.correct] ? `"${q.options[q.correct]}"` : "не вибрано"}
                                        </div>
                                    </>
                                )}

                                {/* ── Multi options editor ── */}
                                {q.type === "multi" && (
                                    <>
                                        <div style={{ fontSize: 11, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8, fontFamily: "inherit" }}>
                                            Варіанти — відмітьте всі правильні
                                        </div>
                                        {q.options.map((opt, oi) => {
                                            const isCorrect = (q.correct || []).includes(oi);
                                            return (
                                                <div key={oi} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                                                    <input type="checkbox" checked={isCorrect}
                                                        onChange={() => {
                                                            const cur = q.correct || [];
                                                            updQuestion(qi, { correct: cur.includes(oi) ? cur.filter(x => x !== oi) : [...cur, oi] });
                                                        }}
                                                        style={{ accentColor: "#1a6a1a", width: 16, height: 16, flexShrink: 0, cursor: "pointer" }} />
                                                    <input value={opt} onChange={e => updOption(qi, oi, e.target.value)}
                                                        placeholder={`Варіант ${oi + 1}`}
                                                        style={{ flex: 1, padding: "7px 10px", borderRadius: 6, fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box", border: `1.5px solid ${isCorrect ? "#8ac040" : "#e0ddd4"}`, background: isCorrect ? "#f0fff0" : "#fff" }} />
                                                    {q.options.length > 2 && (
                                                        <button onClick={() => rmOptionMulti(qi, oi)} style={{ ...miniBtn, color: "#c00", borderColor: "#ffcccc", flexShrink: 0 }}>✕</button>
                                                    )}
                                                </div>
                                            );
                                        })}
                                        {q.options.length < 8 && (
                                            <button onClick={() => addOption(qi)} style={{ background: "transparent", border: "1.5px dashed #ccc", borderRadius: 6, padding: "5px 14px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", color: "#888", marginTop: 4 }}>
                                                + Варіант
                                            </button>
                                        )}
                                        <div style={{ fontSize: 11, color: "#8ac040", marginTop: 10, fontStyle: "italic" }}>
                                            Правильних відповідей: {(q.correct || []).length}
                                        </div>
                                    </>
                                )}

                                {/* ── Match pairs editor ── */}
                                {q.type === "match" && (
                                    <>
                                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: "6px 10px", alignItems: "center", marginBottom: 4 }}>
                                            <div style={{ fontSize: 11, color: "#888", letterSpacing: 1, textTransform: "uppercase", fontFamily: "inherit" }}>Ліва колонка</div>
                                            <div style={{ fontSize: 11, color: "#888", letterSpacing: 1, textTransform: "uppercase", fontFamily: "inherit" }}>Права колонка</div>
                                            <div />
                                            {(q.pairs || []).map((pair, pi) => (
                                                <>
                                                    <input key={`l${pi}`} value={pair.left} onChange={e => updPair(qi, pi, "left", e.target.value)}
                                                        placeholder={`Ліве ${pi + 1}`}
                                                        style={{ padding: "7px 10px", borderRadius: 6, fontSize: 13, fontFamily: "inherit", outline: "none", border: "1.5px solid #e0ddd4", background: "#fff", boxSizing: "border-box" }} />
                                                    <input key={`r${pi}`} value={pair.right} onChange={e => updPair(qi, pi, "right", e.target.value)}
                                                        placeholder={`Праве ${pi + 1}`}
                                                        style={{ padding: "7px 10px", borderRadius: 6, fontSize: 13, fontFamily: "inherit", outline: "none", border: "1.5px solid #e0ddd4", background: "#fff", boxSizing: "border-box" }} />
                                                    <button key={`rm${pi}`} onClick={() => q.pairs.length > 2 && rmPair(qi, pi)} disabled={q.pairs.length <= 2}
                                                        style={{ ...miniBtn, color: "#c00", borderColor: "#ffcccc", opacity: q.pairs.length <= 2 ? 0.3 : 1, cursor: q.pairs.length <= 2 ? "default" : "pointer" }}>✕</button>
                                                </>
                                            ))}
                                        </div>
                                        <button onClick={() => addPair(qi)} style={{ background: "transparent", border: "1.5px dashed #ccc", borderRadius: 6, padding: "5px 14px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", color: "#888", marginTop: 8 }}>
                                            + Пара
                                        </button>
                                        <div style={{ fontSize: 11, color: "#888", marginTop: 10, fontStyle: "italic" }}>
                                            При тесті права колонка перемішується.
                                        </div>
                                    </>
                                )}

                                {/* ── Order items editor ── */}
                                {q.type === "order" && (
                                    <>
                                        <div style={{ fontSize: 11, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8, fontFamily: "inherit" }}>
                                            Елементи у правильному порядку
                                        </div>
                                        {(q.items || []).map((item, ii) => (
                                            <div key={ii} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                                                <span style={{ fontSize: 12, color: "#aaa", minWidth: 18, textAlign: "right", flexShrink: 0 }}>{ii + 1}.</span>
                                                <input value={item} onChange={e => updItem(qi, ii, e.target.value)}
                                                    placeholder={`Елемент ${ii + 1}`}
                                                    style={{ flex: 1, padding: "7px 10px", borderRadius: 6, fontSize: 13, fontFamily: "inherit", outline: "none", border: "1.5px solid #e0ddd4", background: "#fff", boxSizing: "border-box" }} />
                                                {ii > 0 && <button onClick={() => moveItem(qi, ii, -1)} style={miniBtn}>↑</button>}
                                                {ii < (q.items || []).length - 1 && <button onClick={() => moveItem(qi, ii, 1)} style={miniBtn}>↓</button>}
                                                {(q.items || []).length > 2 && (
                                                    <button onClick={() => rmItem(qi, ii)} style={{ ...miniBtn, color: "#c00", borderColor: "#ffcccc" }}>✕</button>
                                                )}
                                            </div>
                                        ))}
                                        <button onClick={() => addItem(qi)} style={{ background: "transparent", border: "1.5px dashed #ccc", borderRadius: 6, padding: "5px 14px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", color: "#888", marginTop: 4 }}>
                                            + Елемент
                                        </button>
                                        <div style={{ fontSize: 11, color: "#888", marginTop: 10, fontStyle: "italic" }}>
                                            При тесті елементи перемішуються. Студент перетягує їх у правильному порядку.
                                        </div>
                                    </>
                                )}
                            </div>
                        ))}

                        {/* Add question buttons */}
                        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                            {[
                                { type: "radio", label: "+ Один варіант", filled: true },
                                { type: "multi", label: "+ Декілька варіантів", filled: false },
                                { type: "match", label: "+ З'єднай", filled: false },
                                { type: "order", label: "+ По порядку", filled: false },
                            ].map(({ type, label, filled }) => (
                                <button key={type} onClick={() => addQuestion(type)}
                                    style={{ flex: 1, minWidth: 140, background: filled ? "#1a1a14" : "transparent", color: filled ? "#e8ff47" : "#1a1a14", border: filled ? "none" : "2px solid #1a1a14", borderRadius: 10, padding: "10px 0", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>

                ) : activeTest ? (
                    /* ── TAKING A TEST ── */
                    <div style={{ background: "#fff", borderRadius: 12, padding: 32, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                        <div style={{ marginBottom: 28, paddingBottom: 20, borderBottom: "2px solid #f0ece2" }}>
                            <h2 style={{ fontSize: 20, fontWeight: 700, color: "#1a1a14", margin: 0 }}>{activeTest.title}</h2>
                        </div>

                        {submitted && score ? (
                            <div>
                                {/* Score summary */}
                                <div style={{ textAlign: "center", padding: "28px 0 24px" }}>
                                    <div style={{ fontSize: 13, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 10 }}>Тест завершено</div>
                                    <div style={{
                                        fontSize: 72, fontWeight: 700, lineHeight: 1, marginBottom: 14,
                                        color: score.correct === score.total ? "#1a6a1a" : score.correct >= Math.ceil(score.total * 0.6) ? "#8a5a1a" : "#c00",
                                    }}>
                                        {score.correct}/{score.total}
                                    </div>
                                    <div style={{ fontSize: 18, color: "#555", marginBottom: 6 }}>
                                        {score.correct === score.total
                                            ? "Відмінно! Всі відповіді правильні."
                                            : score.correct >= Math.ceil(score.total * 0.6)
                                                ? "Непогано! Є що покращити."
                                                : "Потрібно повторити матеріал і спробувати ще раз."}
                                    </div>
                                    <div style={{ fontSize: 13, color: "#aaa" }}>
                                        Правильних відповідей: {score.correct} з {score.total}
                                    </div>
                                </div>

                                {/* Per-question breakdown */}
                                <div style={{ borderTop: "2px solid #f0ece2", paddingTop: 24 }}>
                                    <div style={{ fontSize: 11, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 18, fontWeight: 600 }}>
                                        Розбір відповідей
                                    </div>
                                    {(activeTest.questions || []).map((q, qi) => {
                                        const qCorrect = isQuestionCorrect(q, qi);
                                        return (
                                            <div key={qi} style={{
                                                marginBottom: 16, padding: "16px 20px", borderRadius: 10,
                                                border: `1.5px solid ${qCorrect ? "#b8e6b8" : "#ffcccc"}`,
                                                background: qCorrect ? "#f4fff4" : "#fff5f5",
                                            }}>
                                                <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 12 }}>
                                                    <span style={{ fontSize: 18, flexShrink: 0, lineHeight: 1, color: qCorrect ? "#1a6a1a" : "#c00", marginTop: 1 }}>
                                                        {qCorrect ? "✓" : "✗"}
                                                    </span>
                                                    <div style={{ fontSize: 14, fontWeight: 600, color: "#1a1a14", lineHeight: 1.5 }}>
                                                        {qi + 1}. {q.text}
                                                    </div>
                                                </div>

                                                {/* Radio */}
                                                {q.type === "radio" && (
                                                    <div style={{ display: "flex", flexDirection: "column", gap: 5, paddingLeft: 28 }}>
                                                        {(q.options || []).map((opt, oi) => {
                                                            const isSel = answers[qi] === oi;
                                                            const isRight = q.correct === oi;
                                                            const bg = isRight ? "#e8ffe8" : isSel ? "#fff0f0" : "#fff";
                                                            const border = isRight ? "1.5px solid #1a6a1a" : isSel ? "1.5px solid #c00" : "1px solid #e0ddd4";
                                                            const color = isRight ? "#1a6a1a" : isSel ? "#c00" : "#555";
                                                            return (
                                                                <div key={oi} style={{ padding: "7px 12px", borderRadius: 6, border, background: bg, fontSize: 13, color, display: "flex", alignItems: "center", gap: 8 }}>
                                                                    <span style={{ width: 14, flexShrink: 0 }}>{isRight ? "✓" : isSel ? "✗" : ""}</span>
                                                                    {opt}
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                )}

                                                {/* Multi */}
                                                {q.type === "multi" && (
                                                    <div style={{ display: "flex", flexDirection: "column", gap: 5, paddingLeft: 28 }}>
                                                        {(q.options || []).map((opt, oi) => {
                                                            const isSel = (answers[qi] || []).includes(oi);
                                                            const isRight = (q.correct || []).includes(oi);
                                                            const bg = isRight ? "#e8ffe8" : isSel ? "#fff0f0" : "#fff";
                                                            const border = isRight ? "1.5px solid #1a6a1a" : isSel ? "1.5px solid #c00" : "1px solid #e0ddd4";
                                                            const color = isRight ? "#1a6a1a" : isSel ? "#c00" : "#555";
                                                            return (
                                                                <div key={oi} style={{ padding: "7px 12px", borderRadius: 6, border, background: bg, fontSize: 13, color, display: "flex", alignItems: "center", gap: 8 }}>
                                                                    <span style={{ width: 14, flexShrink: 0 }}>{isRight && isSel ? "✓" : isRight && !isSel ? "○" : isSel ? "✗" : ""}</span>
                                                                    {opt}
                                                                    {isRight && !isSel && <span style={{ fontSize: 11, color: "#1a6a1a", marginLeft: 4, fontStyle: "italic" }}>(правильна)</span>}
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                )}

                                                {/* Match */}
                                                {q.type === "match" && (
                                                    <div style={{ paddingLeft: 28 }}>
                                                        {(q.pairs || []).map((pair, pi) => {
                                                            const userAns = (answers[qi] || {})[pi];
                                                            const pairOk = userAns === pair.right;
                                                            return (
                                                                <div key={pi} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontSize: 13 }}>
                                                                    <span style={{ minWidth: "38%", padding: "6px 10px", background: "#f0ece2", borderRadius: 5, color: "#1a1a14" }}>{pair.left}</span>
                                                                    <span style={{ color: "#aaa" }}>→</span>
                                                                    <span style={{
                                                                        padding: "6px 10px", borderRadius: 5, flex: 1,
                                                                        background: pairOk ? "#e8ffe8" : "#fff0f0",
                                                                        color: pairOk ? "#1a6a1a" : "#c00",
                                                                        border: `1px solid ${pairOk ? "#b8e6b8" : "#ffcccc"}`,
                                                                    }}>
                                                                        {userAns || "—"}
                                                                        {!pairOk && <span style={{ color: "#1a6a1a", marginLeft: 8, fontStyle: "italic", fontSize: 12 }}>→ правильно: {pair.right}</span>}
                                                                    </span>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                )}

                                                {/* Order */}
                                                {q.type === "order" && (
                                                    <div style={{ paddingLeft: 28, display: "flex", gap: 16, flexWrap: "wrap" }}>
                                                        <div style={{ flex: 1, minWidth: 160 }}>
                                                            <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Ваш порядок</div>
                                                            {(answers[qi] || []).map((item, idx) => {
                                                                const itemOk = (q.items || [])[idx] === item;
                                                                return (
                                                                    <div key={idx} style={{
                                                                        padding: "6px 10px", borderRadius: 5, marginBottom: 4, fontSize: 13,
                                                                        display: "flex", gap: 8, alignItems: "center",
                                                                        background: itemOk ? "#e8ffe8" : "#fff0f0",
                                                                        color: itemOk ? "#1a6a1a" : "#c00",
                                                                        border: `1px solid ${itemOk ? "#b8e6b8" : "#ffcccc"}`,
                                                                    }}>
                                                                        <span style={{ fontSize: 11, opacity: 0.6 }}>{idx + 1}.</span>
                                                                        {item}
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                        {!qCorrect && (
                                                            <div style={{ flex: 1, minWidth: 160 }}>
                                                                <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Правильний порядок</div>
                                                                {(q.items || []).map((item, idx) => (
                                                                    <div key={idx} style={{
                                                                        padding: "6px 10px", borderRadius: 5, marginBottom: 4, fontSize: 13,
                                                                        display: "flex", gap: 8, alignItems: "center",
                                                                        background: "#e8ffe8", color: "#1a6a1a", border: "1px solid #b8e6b8",
                                                                    }}>
                                                                        <span style={{ fontSize: 11, opacity: 0.6 }}>{idx + 1}.</span>
                                                                        {item}
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>

                                {/* Buttons */}
                                <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap", marginTop: 28, paddingTop: 20, borderTop: "1.5px solid #f0ece2" }}>
                                    <button onClick={() => startTest(activeTest)}
                                        style={{ ...primBtn, background: "transparent", color: "#1a1a14", border: "1.5px solid #1a1a14" }}>
                                        Пройти ще раз
                                    </button>
                                    <button onClick={() => setActiveTest(null)} style={primBtn}>
                                        До списку тестів
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <>
                                {(activeTest.questions || []).map((q, qi) => (
                                    <div key={qi} style={{ marginBottom: 32 }}>
                                        <div style={{ fontSize: 15, fontWeight: 600, color: "#1a1a14", marginBottom: 14, lineHeight: 1.5 }}>
                                            {qi + 1}. {q.text}
                                        </div>

                                        {/* Radio question */}
                                        {q.type === "radio" && (
                                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                                {(q.options || []).map((opt, oi) => (
                                                    <label key={oi} style={{
                                                        display: "flex", alignItems: "center", gap: 12,
                                                        padding: "10px 14px", borderRadius: 8, cursor: "pointer",
                                                        border: `1.5px solid ${answers[qi] === oi ? "#1a1a14" : "#e0ddd4"}`,
                                                        background: answers[qi] === oi ? "#f0ece2" : "#fff",
                                                        transition: "all .15s", userSelect: "none",
                                                    }}>
                                                        <input type="radio" name={`q${qi}`} checked={answers[qi] === oi}
                                                            onChange={() => setAnswers(p => ({ ...p, [qi]: oi }))}
                                                            style={{ accentColor: "#1a1a14", width: 16, height: 16, flexShrink: 0 }} />
                                                        <span style={{ fontSize: 14, color: "#1a1a14" }}>{opt}</span>
                                                    </label>
                                                ))}
                                            </div>
                                        )}

                                        {/* Multi question */}
                                        {q.type === "multi" && (
                                            <>
                                                <div style={{ fontSize: 12, color: "#888", marginBottom: 10, fontStyle: "italic" }}>
                                                    Можна обрати кілька варіантів
                                                </div>
                                                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                                    {(q.options || []).map((opt, oi) => {
                                                        const selected = (answers[qi] || []).includes(oi);
                                                        return (
                                                            <label key={oi} style={{
                                                                display: "flex", alignItems: "center", gap: 12,
                                                                padding: "10px 14px", borderRadius: 8, cursor: "pointer",
                                                                border: `1.5px solid ${selected ? "#1a1a14" : "#e0ddd4"}`,
                                                                background: selected ? "#f0ece2" : "#fff",
                                                                transition: "all .15s", userSelect: "none",
                                                            }}>
                                                                <input type="checkbox" checked={selected}
                                                                    onChange={() => setAnswers(p => {
                                                                        const cur = p[qi] || [];
                                                                        const next = cur.includes(oi) ? cur.filter(x => x !== oi) : [...cur, oi];
                                                                        return { ...p, [qi]: next };
                                                                    })}
                                                                    style={{ accentColor: "#1a1a14", width: 16, height: 16, flexShrink: 0 }} />
                                                                <span style={{ fontSize: 14, color: "#1a1a14" }}>{opt}</span>
                                                            </label>
                                                        );
                                                    })}
                                                </div>
                                            </>
                                        )}

                                        {/* Match question */}
                                        {q.type === "match" && (
                                            <div style={{ border: "1.5px solid #e0ddd4", borderRadius: 10, overflow: "hidden" }}>
                                                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", background: "#f0ece2", borderBottom: "1.5px solid #e0ddd4" }}>
                                                    <div style={{ padding: "8px 16px", fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 1, fontWeight: 600 }}>Поняття</div>
                                                    <div style={{ padding: "8px 16px", fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 1, fontWeight: 600, borderLeft: "1px solid #e0ddd4" }}>Оберіть відповідь</div>
                                                </div>
                                                {(q.pairs || []).map((pair, pi) => {
                                                    const opts = shuffledRights[qi] || [];
                                                    const selected = (answers[qi] || {})[pi];
                                                    return (
                                                        <div key={pi} style={{
                                                            display: "grid", gridTemplateColumns: "1fr 1fr",
                                                            borderBottom: pi < q.pairs.length - 1 ? "1px solid #f0ece2" : "none",
                                                            background: pi % 2 === 0 ? "#fff" : "#faf8f3",
                                                        }}>
                                                            <div style={{ padding: "12px 16px", fontSize: 14, color: "#1a1a14", display: "flex", alignItems: "center" }}>
                                                                {pair.left}
                                                            </div>
                                                            <div style={{ padding: "8px 12px", borderLeft: "1px solid #e0ddd4", display: "flex", alignItems: "center" }}>
                                                                <select value={selected || ""}
                                                                    onChange={e => setAnswers(p => ({ ...p, [qi]: { ...(p[qi] || {}), [pi]: e.target.value } }))}
                                                                    style={{ width: "100%", padding: "7px 10px", borderRadius: 6, fontSize: 13, fontFamily: "Georgia, serif", outline: "none", cursor: "pointer", border: `1.5px solid ${selected ? "#1a1a14" : "#e0ddd4"}`, background: selected ? "#f0ece2" : "#fff", color: "#1a1a14" }}>
                                                                    <option value="">— оберіть —</option>
                                                                    {opts.map((opt, oi) => <option key={oi} value={opt}>{opt}</option>)}
                                                                </select>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}

                                        {/* Order question */}
                                        {q.type === "order" && (
                                            <>
                                                <div style={{ fontSize: 12, color: "#888", marginBottom: 10, fontStyle: "italic" }}>
                                                    Перетягуйте елементи щоб розставити у правильному порядку
                                                </div>
                                                <div>
                                                    {(answers[qi] || []).map((item, idx) => {
                                                        const isOver = dragOver.qi === qi && dragOver.idx === idx;
                                                        return (
                                                            <div key={idx}
                                                                draggable
                                                                onDragStart={() => handleDragStart(qi, idx)}
                                                                onDragOver={e => handleDragOver(e, qi, idx)}
                                                                onDrop={() => handleDrop(qi, idx)}
                                                                onDragEnd={handleDragEnd}
                                                                style={{
                                                                    display: "flex", alignItems: "center", gap: 12,
                                                                    padding: "10px 14px", borderRadius: 8,
                                                                    border: `1.5px solid ${isOver ? "#1a1a14" : "#e0ddd4"}`,
                                                                    background: isOver ? "#f0ece2" : "#fff",
                                                                    marginBottom: 8, userSelect: "none", cursor: "grab",
                                                                    transition: "border-color .1s, background .1s",
                                                                    transform: isOver ? "scale(1.01)" : "none",
                                                                }}>
                                                                <span style={{ color: "#ccc", fontSize: 18, lineHeight: 1, cursor: "grab", flexShrink: 0 }}>⠿</span>
                                                                <span style={{ fontSize: 14, color: "#1a1a14", flex: 1 }}>{item}</span>
                                                                <span style={{ fontSize: 12, color: "#bbb", flexShrink: 0 }}>{idx + 1}</span>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </>
                                        )}
                                    </div>
                                ))}

                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 32, paddingTop: 20, borderTop: "1.5px solid #f0ece2", flexWrap: "wrap", gap: 12 }}>
                                    <div style={{ fontSize: 13, color: "#888" }}>
                                        Відповіді: {(activeTest.questions || []).filter((q, qi) => {
                                            if (q.type === "match") return (q.pairs || []).every((_, pi) => (answers[qi] || {})[pi]);
                                            if (q.type === "order") return true;
                                            if (q.type === "multi") return (answers[qi] || []).length > 0;
                                            return answers[qi] !== undefined;
                                        }).length} / {activeTest.questions?.length || 0}
                                    </div>
                                    <button onClick={submitTest} disabled={submitting || !allAnswered}
                                        style={{ ...primBtn, opacity: submitting || !allAnswered ? 0.45 : 1, cursor: submitting || !allAnswered ? "default" : "pointer" }}>
                                        {submitting ? "Відправка..." : "Відправити →"}
                                    </button>
                                </div>
                            </>
                        )}
                    </div>

                ) : (
                    /* ── TEST LIST ── */
                    <>
                        <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: 2, color: "#1a1a14", marginBottom: 24, textTransform: "uppercase" }}>
                            Тести
                        </div>

                        {loading ? (
                            <div style={{ color: "#888", fontSize: 14 }}>Завантаження...</div>
                        ) : tests.length === 0 ? (
                            <div style={{ background: "#fff", borderRadius: 12, padding: 40, textAlign: "center", boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                                <div style={{ color: "#aaa", fontSize: 14, marginBottom: isAdmin ? 20 : 0 }}>Тести ще не додано.</div>
                                {isAdmin && <button onClick={startNewTest} style={primBtn}>+ Створити перший тест</button>}
                            </div>
                        ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                                {tests.map(test => {
                                    const best = getBestResult(test.id);
                                    return (
                                        <div key={test.id} style={{ background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 2px 12px rgba(0,0,0,0.06)", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div style={{ fontSize: 16, fontWeight: 700, color: "#1a1a14", marginBottom: 5 }}>{test.title}</div>
                                                <div style={{ fontSize: 12, color: "#aaa" }}>
                                                    {test.questions?.length || 0} питань
                                                    {best && (
                                                        <span style={{ marginLeft: 14, color: best.passed ? "#1a6a1a" : "#8a5a1a", fontWeight: 600 }}>
                                                            Кращий результат: {best.score}/{best.total}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                            {best && (
                                                <div style={{ padding: "4px 14px", borderRadius: 20, fontSize: 12, fontWeight: 600, flexShrink: 0, background: best.passed ? "#e4ffe4" : "#fff3e0", color: best.passed ? "#1a6a1a" : "#8a5a1a" }}>
                                                    {best.passed ? "Пройдено" : "Не пройдено"}
                                                </div>
                                            )}
                                            {isAdmin && (
                                                <>
                                                    <button onClick={() => startEditTest(test)}
                                                        style={{ background: "#f0f5ff", border: "1px solid #c0d0f0", color: "#1a5a8a", borderRadius: 6, padding: "6px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>
                                                        Редагувати
                                                    </button>
                                                    <button onClick={() => deleteTest(test.id)}
                                                        style={{ background: "transparent", border: "1px solid #ffcccc", color: "#c00", borderRadius: 6, padding: "6px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>
                                                        ✕
                                                    </button>
                                                </>
                                            )}
                                            <button onClick={() => startTest(test)} style={{ ...primBtn, flexShrink: 0 }}>
                                                {best ? "Ще раз" : "Почати →"}
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                    </>
                )}
            </div>
        </div>
    );
}
