import { useState, useEffect, useRef, Component } from "react";
import { db } from "./firebase";
import { collection, getDocs, doc, setDoc, addDoc, deleteDoc, query, orderBy } from "firebase/firestore";
import { useAuth } from "./AuthContext";
import TrainingTests from "./TrainingTests";

function genId() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function toYoutubeEmbed(url) {
    if (!url) return "";
    const m = url.match(/[?&]v=([^&]+)/) || url.match(/youtu\.be\/([^?&]+)/);
    return m ? `https://www.youtube.com/embed/${m[1]}` : url;
}

function toDriveEmbed(url, page) {
    if (!url) return "";
    const suffix = page ? `#page=${page}` : "";
    const file = url.match(/\/file\/d\/([^\/\?]+)/);
    if (file) return `https://drive.google.com/file/d/${file[1]}/preview${suffix}`;
    const docs = url.match(/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([^\/\?]+)/);
    if (docs) return `https://docs.google.com/${docs[1]}/d/${docs[2]}/preview${suffix}`;
    const open = url.match(/[?&]id=([^&]+)/);
    if (open) return `https://drive.google.com/file/d/${open[1]}/preview${suffix}`;
    return url + suffix;
}

const isHtml = (s) => /<[a-z][\s\S]*>/i.test(s || "");

// ── Rich text editor ────────────────────────────────────────────────────────

function RichTextEditor({ value, onChange }) {
    const ref = useRef(null);
    const savedSel = useRef(null);

    useEffect(() => {
        if (ref.current) ref.current.innerHTML = value || "";
    }, []);

    const saveSelection = () => {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) savedSel.current = sel.getRangeAt(0).cloneRange();
    };

    const restoreSelection = () => {
        if (!savedSel.current) return;
        ref.current.focus();
        const sel = window.getSelection();
        if (sel) { sel.removeAllRanges(); sel.addRange(savedSel.current); }
    };

    const exec = (cmd, val = null) => {
        ref.current.focus();
        document.execCommand(cmd, false, val);
        onChange(ref.current.innerHTML);
    };

    const setFontSize = (px) => {
        ref.current.focus();
        document.execCommand("fontSize", false, "7");
        ref.current.querySelectorAll("font[size='7']").forEach(el => {
            el.style.fontSize = px + "px";
            el.removeAttribute("size");
        });
        onChange(ref.current.innerHTML);
    };

    const tb = {
        background: "transparent", border: "1px solid #ddd", borderRadius: 4,
        padding: "3px 7px", fontSize: 13, cursor: "pointer", fontFamily: "inherit", color: "#444",
        lineHeight: 1.2, flexShrink: 0,
    };
    const sep = <div style={{ width: 1, height: 18, background: "#ddd", margin: "0 2px", flexShrink: 0 }} />;
    const row = {
        display: "flex", gap: 3, padding: "5px 8px", background: "#f5f2eb",
        border: "1.5px solid #e0ddd4", flexWrap: "wrap", alignItems: "center",
    };

    return (
        <div>
            {/* Row 1: inline + size + colors */}
            <div style={{ ...row, borderRadius: "6px 6px 0 0", borderBottom: "1px solid #e0ddd4" }}>
                <button onMouseDown={e => { e.preventDefault(); exec("bold"); }} style={tb}><b>Ж</b></button>
                <button onMouseDown={e => { e.preventDefault(); exec("italic"); }} style={tb}><i>К</i></button>
                <button onMouseDown={e => { e.preventDefault(); exec("underline"); }} style={tb}><u>П</u></button>
                <button onMouseDown={e => { e.preventDefault(); exec("strikeThrough"); }} style={tb}><s>aв</s></button>
                {sep}
                <select defaultValue="" onChange={e => { if (e.target.value) { setFontSize(e.target.value); e.target.value = ""; } }}
                    style={{ ...tb, padding: "3px 4px", fontSize: 12 }}>
                    <option value="" disabled>Розмір</option>
                    {[10, 11, 12, 13, 14, 15, 16, 18, 20, 24].map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                {sep}
                {/* Text color */}
                <label title="Колір тексту" style={{ ...tb, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 3, position: "relative", overflow: "hidden" }}>
                    <b style={{ fontSize: 13 }}>А</b>
                    <input type="color" defaultValue="#000000"
                        onMouseDown={saveSelection}
                        onChange={e => { restoreSelection(); exec("foreColor", e.target.value); }}
                        style={{ opacity: 0, position: "absolute", inset: 0, width: "100%", height: "100%", cursor: "pointer", border: "none", padding: 0 }} />
                </label>
                {/* Highlight color */}
                <label title="Виділення кольором" style={{ ...tb, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 3, position: "relative", overflow: "hidden" }}>
                    <b style={{ fontSize: 13, background: "#ffff00", padding: "0 2px" }}>А</b>
                    <input type="color" defaultValue="#ffff00"
                        onMouseDown={saveSelection}
                        onChange={e => { restoreSelection(); exec("hiliteColor", e.target.value); }}
                        style={{ opacity: 0, position: "absolute", inset: 0, width: "100%", height: "100%", cursor: "pointer", border: "none", padding: 0 }} />
                </label>
                {sep}
                <button onMouseDown={e => { e.preventDefault(); exec("removeFormat"); }} style={{ ...tb, fontSize: 11, color: "#999" }}>✕ формат</button>
            </div>
            {/* Row 2: headings + align + lists + indent */}
            <div style={{ ...row, borderTop: "none", borderBottom: "none" }}>
                <button onMouseDown={e => { e.preventDefault(); document.execCommand("formatBlock", false, "h2"); onChange(ref.current.innerHTML); }} style={{ ...tb, fontWeight: 700, fontSize: 11 }} title="Заголовок 1">H1</button>
                <button onMouseDown={e => { e.preventDefault(); document.execCommand("formatBlock", false, "h3"); onChange(ref.current.innerHTML); }} style={{ ...tb, fontWeight: 700, fontSize: 11 }} title="Заголовок 2">H2</button>
                <button onMouseDown={e => { e.preventDefault(); document.execCommand("formatBlock", false, "div"); onChange(ref.current.innerHTML); }} style={{ ...tb, fontSize: 11, color: "#888" }} title="Звичайний текст">¶</button>
                {sep}
                <button onMouseDown={e => { e.preventDefault(); exec("justifyLeft"); }} style={tb} title="По лівому краю">⬅</button>
                <button onMouseDown={e => { e.preventDefault(); exec("justifyCenter"); }} style={tb} title="По центру">↔</button>
                <button onMouseDown={e => { e.preventDefault(); exec("justifyRight"); }} style={tb} title="По правому краю">➡</button>
                {sep}
                <button onMouseDown={e => { e.preventDefault(); exec("insertUnorderedList"); }} style={tb} title="Маркований список">• список</button>
                <button onMouseDown={e => { e.preventDefault(); exec("insertOrderedList"); }} style={tb} title="Нумерований список">1. список</button>
                {sep}
                <button onMouseDown={e => { e.preventDefault(); exec("indent"); }} style={{ ...tb, fontSize: 12 }} title="Збільшити відступ">→|</button>
                <button onMouseDown={e => { e.preventDefault(); exec("outdent"); }} style={{ ...tb, fontSize: 12 }} title="Зменшити відступ">|←</button>
            </div>
            <div
                ref={ref}
                contentEditable
                suppressContentEditableWarning
                onInput={() => onChange(ref.current.innerHTML)}
                style={{
                    minHeight: 120, padding: "10px 12px",
                    border: "1.5px solid #e0ddd4", borderTop: "none",
                    borderRadius: "0 0 6px 6px",
                    fontSize: 14, fontFamily: "Georgia, serif",
                    lineHeight: 1.7, outline: "none", background: "#fff",
                }}
            />
        </div>
    );
}

// ── Content viewer ───────────────────────────────────────────────────────────

class ContentErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { error: null };
    }
    static getDerivedStateFromError(error) {
        return { error };
    }
    componentDidCatch(error, info) {
        console.error("Помилка рендеру контенту навчання:", error, info);
    }
    render() {
        if (this.state.error) {
            return (
                <div style={{ color: "#c00", fontSize: 13, padding: "16px 0" }}>
                    Не вдалося показати цей контент — дані пошкоджені. Спробуйте відредагувати або видалити цей блок.
                </div>
            );
        }
        return this.props.children;
    }
}

function ContentView({ blocks }) {
    if (!blocks?.length) return (
        <div style={{ color: "#aaa", fontSize: 14, fontStyle: "italic", padding: "20px 0" }}>Контент ще не додано</div>
    );
    return (
        <>
            {blocks.map((block, bi) => {
                const prevIsText = bi > 0 && blocks[bi - 1]?.type === "text";
                if (block.type === "text") {
                    const html = block.value || "";
                    return (
                        <div key={block.id}>
                            {prevIsText && (
                                <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "8px 0 24px 0" }}>
                                    <div style={{ flex: 1, height: 2, background: "#e8ff47", borderRadius: 2 }} />
                                </div>
                            )}
                            {isHtml(html) ? (
                                <div className="tr-html" style={{ fontSize: 15, lineHeight: 1.85, color: "#2a2a1e", marginBottom: 20 }}
                                    dangerouslySetInnerHTML={{ __html: html }} />
                            ) : (
                                <p style={{ fontSize: 15, lineHeight: 1.85, color: "#2a2a1e", marginBottom: 20, whiteSpace: "pre-wrap" }}>
                                    {html}
                                </p>
                            )}
                        </div>
                    );
                }

                if (block.type === "image" && block.url) return (
                    <div key={block.id} style={{ marginBottom: 28, textAlign: "center" }}>
                        <img src={block.url} alt={block.caption || ""} style={{ maxWidth: "100%", maxHeight: 480, borderRadius: 8, boxShadow: "0 4px 20px rgba(0,0,0,0.12)" }} />
                        {block.caption && <div style={{ fontSize: 12, color: "#888", marginTop: 8, fontStyle: "italic" }}>{block.caption}</div>}
                    </div>
                );

                if (block.type === "video" && block.url) return (
                    <div key={block.id} style={{ marginBottom: 28 }}>
                        <div style={{ position: "relative", paddingBottom: "56.25%", borderRadius: 8, overflow: "hidden", boxShadow: "0 4px 20px rgba(0,0,0,0.12)" }}>
                            <iframe src={toYoutubeEmbed(block.url)} style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", border: "none" }} allowFullScreen title={block.caption || "video"} />
                        </div>
                        {block.caption && <div style={{ fontSize: 12, color: "#888", marginTop: 8, fontStyle: "italic" }}>{block.caption}</div>}
                    </div>
                );

                if (block.type === "drive" && block.url) return (
                    <div key={block.id} style={{ marginBottom: 28 }}>
                        <div style={{ width: "100%", height: 520, borderRadius: 8, overflow: "hidden", boxShadow: "0 4px 20px rgba(0,0,0,0.12)" }}>
                            <iframe src={toDriveEmbed(block.url, block.page)} style={{ width: "100%", height: "100%", border: "none" }} allowFullScreen title={block.caption || "Google Drive"} />
                        </div>
                        {block.caption && <div style={{ fontSize: 12, color: "#888", marginTop: 8, fontStyle: "italic", textAlign: "center" }}>{block.caption}</div>}
                    </div>
                );

                if (block.type === "table" && block.headers?.length) return (
                    <div key={block.id} style={{ marginBottom: 28, overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                            <thead>
                                <tr>
                                    {block.headers.map((h, i) => (
                                        <th key={i} style={{ padding: "10px 14px", background: "#1a1a14", color: "#e8ff47", fontSize: 12, fontWeight: 700, textAlign: "left", borderRight: "1px solid #333" }}>
                                            {h}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {(block.rows || []).map((row, ri) => (
                                    <tr key={ri} style={{ background: ri % 2 === 0 ? "#fff" : "#faf8f3" }}>
                                        {(Array.isArray(row) ? row : []).map((cell, ci) => (
                                            <td key={ci} style={{ padding: "9px 14px", borderBottom: "1px solid #f0ece2", borderRight: "1px solid #f0ece2", color: "#2a2a1e", lineHeight: 1.5 }}>
                                                {cell}
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {block.caption && <div style={{ fontSize: 12, color: "#888", marginTop: 8, fontStyle: "italic", textAlign: "center" }}>{block.caption}</div>}
                    </div>
                );

                if (block.type === "carousel") return (
                    <CarouselView key={block.id} block={block} />
                );

                if (block.type === "cards" && block.cards?.length) return (
                    <CardsView key={block.id} block={block} />
                );

                return null;
            })}
        </>
    );
}

// ── Block editor ─────────────────────────────────────────────────────────────

const miniBtn = {
    background: "transparent", border: "1px solid #ddd", borderRadius: 4,
    padding: "3px 8px", fontSize: 11, cursor: "pointer", color: "#666", fontFamily: "inherit",
};

const BLOCK_LABELS = { text: "Текст", image: "Фото", video: "Відео", drive: "Google Drive", table: "Таблиця", carousel: "Карусель", cards: "Картки" };

function BlockEditor({ block, onUpdate, onRemove, onMoveUp, onMoveDown, isFirst, isLast }) {
    return (
        <div style={{ border: "1.5px solid #e0ddd4", borderRadius: 8, padding: 12, marginBottom: 10, background: "#fff" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                <span style={{ fontSize: 10, color: "#888", background: "#f0ece2", padding: "2px 8px", borderRadius: 4, textTransform: "uppercase", letterSpacing: 1, fontFamily: "inherit" }}>
                    {BLOCK_LABELS[block.type] || block.type}
                </span>
                <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                    {!isFirst && <button onClick={onMoveUp} style={miniBtn}>↑</button>}
                    {!isLast && <button onClick={onMoveDown} style={miniBtn}>↓</button>}
                    <button onClick={onRemove} style={{ ...miniBtn, color: "#c00", borderColor: "#ffcccc" }}>✕</button>
                </div>
            </div>

            {/* Text — rich editor */}
            {block.type === "text" && (
                <RichTextEditor
                    key={block.id}
                    value={block.value || ""}
                    onChange={val => onUpdate({ ...block, value: val })}
                />
            )}

            {/* Image / Video */}
            {(block.type === "image" || block.type === "video") && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <input
                        value={block.url || ""}
                        onChange={e => onUpdate({ ...block, url: e.target.value })}
                        placeholder={block.type === "image" ? "URL зображення (https://...)" : "YouTube URL"}
                        style={{ width: "100%", padding: "8px 10px", border: "1.5px solid #e0ddd4", borderRadius: 6, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", outline: "none" }}
                    />
                    <input
                        value={block.caption || ""}
                        onChange={e => onUpdate({ ...block, caption: e.target.value })}
                        placeholder="Підпис (необов'язково)"
                        style={{ width: "100%", padding: "8px 10px", border: "1.5px solid #e0ddd4", borderRadius: 6, fontSize: 12, fontFamily: "inherit", boxSizing: "border-box", color: "#888", outline: "none" }}
                    />
                </div>
            )}

            {/* Google Drive */}
            {block.type === "drive" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <input
                        value={block.url || ""}
                        onChange={e => onUpdate({ ...block, url: e.target.value })}
                        placeholder="Посилання з Google Drive (файл має бути відкритий для перегляду)"
                        style={{ width: "100%", padding: "8px 10px", border: "1.5px solid #e0ddd4", borderRadius: 6, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", outline: "none" }}
                    />
                    <div style={{ display: "flex", gap: 8 }}>
                        <input
                            value={block.caption || ""}
                            onChange={e => onUpdate({ ...block, caption: e.target.value })}
                            placeholder="Підпис (необов'язково)"
                            style={{ flex: 1, padding: "8px 10px", border: "1.5px solid #e0ddd4", borderRadius: 6, fontSize: 12, fontFamily: "inherit", boxSizing: "border-box", color: "#888", outline: "none" }}
                        />
                        <input
                            type="number"
                            min="1"
                            value={block.page || ""}
                            onChange={e => onUpdate({ ...block, page: e.target.value })}
                            placeholder="Сторінка"
                            title="Відкрити на сторінці (для PDF)"
                            style={{ width: 100, padding: "8px 10px", border: "1.5px solid #e0ddd4", borderRadius: 6, fontSize: 12, fontFamily: "inherit", boxSizing: "border-box", color: "#888", outline: "none" }}
                        />
                    </div>
                </div>
            )}

            {/* Table */}
            {block.type === "table" && (
                <div>
                    <div style={{ overflowX: "auto", marginBottom: 8 }}>
                        <table style={{ borderCollapse: "collapse", minWidth: 280 }}>
                            <thead>
                                <tr>
                                    {(block.headers || []).map((h, ci) => (
                                        <th key={ci} style={{ padding: 0, verticalAlign: "top" }}>
                                            <div style={{ display: "flex" }}>
                                                <input
                                                    value={h}
                                                    onChange={e => onUpdate({ ...block, headers: block.headers.map((x, i) => i === ci ? e.target.value : x) })}
                                                    style={{ width: "100%", minWidth: 80, padding: "6px 8px", border: "1px solid #e0ddd4", background: "#f5f2eb", fontWeight: 700, fontSize: 12, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}
                                                />
                                                {block.headers.length > 1 && (
                                                    <button onClick={() => onUpdate({
                                                        ...block,
                                                        headers: block.headers.filter((_, i) => i !== ci),
                                                        rows: (block.rows || []).map(r => r.filter((_, i) => i !== ci)),
                                                    })} style={{ background: "#f0ece2", border: "none", color: "#aaa", cursor: "pointer", padding: "0 6px", fontSize: 11 }}>✕</button>
                                                )}
                                            </div>
                                        </th>
                                    ))}
                                    <th style={{ verticalAlign: "middle", paddingLeft: 4 }}>
                                        <button onClick={() => onUpdate({
                                            ...block,
                                            headers: [...(block.headers || []), `Колонка ${(block.headers || []).length + 1}`],
                                            rows: (block.rows || []).map(r => [...r, ""]),
                                        })} style={{ background: "transparent", border: "1px solid #ddd", borderRadius: 4, color: "#888", cursor: "pointer", fontSize: 14, padding: "2px 8px", fontFamily: "inherit" }}>+</button>
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {(block.rows || []).map((row, ri) => (
                                    <tr key={ri}>
                                        {row.map((cell, ci) => (
                                            <td key={ci} style={{ padding: 0 }}>
                                                <input
                                                    value={cell}
                                                    onChange={e => onUpdate({
                                                        ...block,
                                                        rows: block.rows.map((r, i) => i === ri ? r.map((c, j) => j === ci ? e.target.value : c) : r),
                                                    })}
                                                    style={{ width: "100%", minWidth: 80, padding: "6px 8px", border: "1px solid #f0ece2", background: "#fff", fontSize: 12, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}
                                                />
                                            </td>
                                        ))}
                                        <td style={{ verticalAlign: "middle", paddingLeft: 4 }}>
                                            <button onClick={() => onUpdate({ ...block, rows: block.rows.filter((_, i) => i !== ri) })}
                                                style={{ background: "transparent", border: "none", color: "#bbb", cursor: "pointer", fontSize: 12, padding: "4px 6px" }}>✕</button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                        <button onClick={() => onUpdate({ ...block, rows: [...(block.rows || []), new Array((block.headers || []).length).fill("")] })}
                            style={{ background: "transparent", border: "1.5px dashed #ccc", borderRadius: 6, padding: "4px 12px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", color: "#888" }}>
                            + Рядок
                        </button>
                    </div>
                    <input
                        value={block.caption || ""}
                        onChange={e => onUpdate({ ...block, caption: e.target.value })}
                        placeholder="Підпис таблиці (необов'язково)"
                        style={{ width: "100%", padding: "6px 10px", border: "1.5px solid #e0ddd4", borderRadius: 6, fontSize: 12, fontFamily: "inherit", color: "#888", outline: "none", boxSizing: "border-box" }}
                    />
                </div>
            )}

            {/* Carousel */}
            {block.type === "carousel" && (
                <CarouselEditor block={block} onUpdate={onUpdate} />
            )}

            {/* Cards */}
            {block.type === "cards" && (
                <CardsEditor block={block} onUpdate={onUpdate} />
            )}
        </div>
    );
}

// ── Main component ───────────────────────────────────────────────────────────

const BLOCK_TYPES = [
    { type: "text",     label: "+ Текст" },
    { type: "image",    label: "+ Фото" },
    { type: "video",    label: "+ Відео" },
    { type: "drive",    label: "+ Google Drive" },
    { type: "table",    label: "+ Таблиця" },
    { type: "carousel", label: "+ Карусель" },
    { type: "cards",    label: "+ Картки" },
];

const SLIDE_BLOCK_TYPES = BLOCK_TYPES.filter(b => b.type !== "carousel");

const NEW_BLOCK = {
    text:     () => ({ id: genId(), type: "text",  value: "" }),
    image:    () => ({ id: genId(), type: "image", url: "", caption: "" }),
    video:    () => ({ id: genId(), type: "video", url: "", caption: "" }),
    drive:    () => ({ id: genId(), type: "drive", url: "", caption: "" }),
    table:    () => ({ id: genId(), type: "table", caption: "", headers: ["Колонка 1", "Колонка 2"], rows: [["", ""], ["", ""]] }),
    carousel: () => ({ id: genId(), type: "carousel", slides: [
        { id: genId(), title: "Слайд 1", content: [] },
        { id: genId(), title: "Слайд 2", content: [] },
    ]}),
    cards: () => ({ id: genId(), type: "cards", cards: [
        { id: genId(), label: "", value: "", desc: "" },
        { id: genId(), label: "", value: "", desc: "" },
    ]}),
};

// ── Cards view ────────────────────────────────────────────────────────────────

function CardsView({ block }) {
    return (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 24 }}>
            {(block.cards || []).map(card => (
                <div key={card.id} style={{ border: "1.5px solid #e8ff47", borderRadius: 12, padding: "16px 18px", background: "#fff" }}>
                    {card.label && (
                        <div style={{ fontSize: 10, color: "#aaa", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8, fontFamily: "inherit" }}>
                            {card.label}
                        </div>
                    )}
                    {card.value && (
                        <div style={{ fontSize: 22, fontWeight: 700, color: "#1a1a14", marginBottom: 6, fontFamily: "Georgia, serif", lineHeight: 1.2 }}>
                            {card.value}
                        </div>
                    )}
                    {card.desc && (
                        <div style={{ fontSize: 13, color: "#666", lineHeight: 1.65, whiteSpace: "pre-line" }}>
                            {card.desc}
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}

// ── Cards editor ──────────────────────────────────────────────────────────────

function CardsEditor({ block, onUpdate }) {
    const updCards = (cards) => onUpdate({ ...block, cards });
    const addCard = () => updCards([...(block.cards || []), { id: genId(), label: "", value: "", desc: "" }]);
    const rmCard = (i) => updCards((block.cards || []).filter((_, idx) => idx !== i));
    const updCard = (i, patch) => updCards((block.cards || []).map((c, idx) => idx === i ? { ...c, ...patch } : c));

    const fieldStyle = (fontSize, bold) => ({
        width: "100%", padding: "4px 0", border: "none", borderBottom: "1px solid #e8e8e0",
        fontSize, fontWeight: bold ? 700 : 400,
        fontFamily: bold ? "Georgia, serif" : "inherit",
        color: bold ? "#1a1a14" : "#666", background: "transparent",
        outline: "none", boxSizing: "border-box", marginBottom: 6,
    });

    return (
        <div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, marginBottom: 10 }}>
                {(block.cards || []).map((card, i) => (
                    <div key={card.id} style={{ border: "1.5px solid #e0ddd4", borderRadius: 8, padding: "10px 10px 6px", background: "#fafaf7", position: "relative" }}>
                        <button onClick={() => rmCard(i)} style={{ position: "absolute", top: 6, right: 6, ...miniBtn, color: "#c00", borderColor: "#ffcccc", padding: "1px 5px", fontSize: 10 }}>✕</button>
                        <input value={card.label} onChange={e => updCard(i, { label: e.target.value })}
                            placeholder="ЗАГОЛОВОК КАРТКИ"
                            style={{ ...fieldStyle(10, false), textTransform: "uppercase", letterSpacing: 1, color: "#aaa", paddingRight: 20 }} />
                        <input value={card.value} onChange={e => updCard(i, { value: e.target.value })}
                            placeholder="Основне значення"
                            style={fieldStyle(18, true)} />
                        <textarea value={card.desc} onChange={e => updCard(i, { desc: e.target.value })}
                            placeholder={"Опис (необов'язково)"}
                            rows={2}
                            style={{ ...fieldStyle(12, false), resize: "none", lineHeight: 1.5 }} />
                    </div>
                ))}
            </div>
            <button onClick={addCard} style={{ background: "transparent", border: "1.5px dashed #ccc", borderRadius: 7, padding: "5px 14px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", color: "#888" }}>
                + Картка
            </button>
        </div>
    );
}

// ── Carousel view ─────────────────────────────────────────────────────────────

function CarouselView({ block }) {
    const [cur, setCur] = useState(0);
    const slides = block.slides || [];
    if (!slides.length) return null;
    const slide = slides[Math.min(cur, slides.length - 1)];

    const navBtn = (disabled) => ({
        background: "transparent", border: "1px solid " + (disabled ? "#e0ddd4" : "#bbb"),
        borderRadius: 6, padding: "5px 16px", cursor: disabled ? "default" : "pointer",
        fontSize: 13, color: disabled ? "#ccc" : "#444", fontFamily: "inherit",
    });

    return (
        <div style={{ border: "2px solid #e8ff47", borderRadius: 12, overflow: "hidden", marginBottom: 24 }}>
            {/* Slide tabs */}
            <div style={{ background: "#1a1a14", display: "flex", overflowX: "auto" }}>
                {slides.map((s, i) => (
                    <button key={s.id} onClick={() => setCur(i)} style={{
                        background: i === cur ? "#e8ff47" : "transparent",
                        color: i === cur ? "#1a1a14" : "#888",
                        border: "none", padding: "10px 20px",
                        cursor: "pointer", fontSize: 13, fontFamily: "Georgia, serif",
                        fontWeight: i === cur ? 700 : 400, whiteSpace: "nowrap", flexShrink: 0,
                    }}>
                        {s.title || `Слайд ${i + 1}`}
                    </button>
                ))}
            </div>
            {/* Content */}
            <div style={{ padding: "20px 24px", minHeight: 60 }}>
                <ContentView blocks={slide.content || []} />
            </div>
            {/* Navigation */}
            {slides.length > 1 && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 20px", borderTop: "1px solid #f0ece2", background: "#faf8f3" }}>
                    <button onClick={() => setCur(p => Math.max(0, p - 1))} disabled={cur === 0} style={navBtn(cur === 0)}>← Назад</button>
                    <span style={{ fontSize: 12, color: "#aaa" }}>{cur + 1} / {slides.length}</span>
                    <button onClick={() => setCur(p => Math.min(slides.length - 1, p + 1))} disabled={cur === slides.length - 1} style={navBtn(cur === slides.length - 1)}>Далі →</button>
                </div>
            )}
        </div>
    );
}

// ── Carousel editor ───────────────────────────────────────────────────────────

function CarouselEditor({ block, onUpdate }) {
    const [activeSlide, setActiveSlide] = useState(0);
    const slides = block.slides || [];

    const updSlides = (s) => onUpdate({ ...block, slides: s });
    const addSlide = () => { updSlides([...slides, { id: genId(), title: `Слайд ${slides.length + 1}`, content: [] }]); };
    const rmSlide = (i) => {
        const s = slides.filter((_, idx) => idx !== i);
        updSlides(s);
        setActiveSlide(p => Math.min(p, s.length - 1));
    };
    const updSlide = (i, patch) => updSlides(slides.map((s, idx) => idx === i ? { ...s, ...patch } : s));
    const updSlideBlock = (si, bi, blk) => updSlides(slides.map((s, idx) => idx !== si ? s : {
        ...s, content: s.content.map((b, k) => k === bi ? blk : b)
    }));
    const rmSlideBlock = (si, bi) => updSlides(slides.map((s, idx) => idx !== si ? s : {
        ...s, content: s.content.filter((_, k) => k !== bi)
    }));
    const moveSlideBlock = (si, bi, dir) => updSlides(slides.map((s, idx) => {
        if (idx !== si) return s;
        const c = [...s.content]; const t = bi + dir;
        if (t < 0 || t >= c.length) return s;
        [c[bi], c[t]] = [c[t], c[bi]]; return { ...s, content: c };
    }));
    const addSlideBlock = (si, type) => updSlides(slides.map((s, idx) => idx !== si ? s : {
        ...s, content: [...(s.content || []), NEW_BLOCK[type]()]
    }));

    const slide = slides[activeSlide];

    return (
        <div style={{ border: "2px solid #e8ff47", borderRadius: 8, overflow: "hidden" }}>
            {/* Tabs */}
            <div style={{ background: "#1a1a14", display: "flex", flexWrap: "wrap", gap: 4, padding: "8px 10px", alignItems: "center" }}>
                {slides.map((s, i) => (
                    <button key={s.id} onClick={() => setActiveSlide(i)} style={{
                        background: i === activeSlide ? "#e8ff47" : "transparent",
                        color: i === activeSlide ? "#1a1a14" : "#888",
                        border: "1px solid " + (i === activeSlide ? "#e8ff47" : "#555"),
                        borderRadius: 4, padding: "3px 12px", cursor: "pointer",
                        fontSize: 12, fontFamily: "inherit", fontWeight: i === activeSlide ? 700 : 400,
                    }}>
                        {s.title || `Слайд ${i + 1}`}
                    </button>
                ))}
                <button onClick={addSlide} style={{ background: "transparent", border: "1px dashed #555", borderRadius: 4, color: "#888", cursor: "pointer", padding: "3px 10px", fontSize: 11, fontFamily: "inherit" }}>
                    + слайд
                </button>
            </div>
            {/* Slide content */}
            {slide && (
                <div style={{ padding: 12, background: "#fafaf7" }}>
                    <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                        <input
                            value={slide.title}
                            onChange={e => updSlide(activeSlide, { title: e.target.value })}
                            placeholder="Назва слайду"
                            style={{ flex: 1, padding: "5px 8px", border: "1.5px solid #e0ddd4", borderRadius: 6, fontSize: 13, fontFamily: "Georgia, serif", fontWeight: 600, outline: "none", background: "#fff" }}
                        />
                        {slides.length > 1 && (
                            <button onClick={() => rmSlide(activeSlide)} style={{ ...miniBtn, color: "#c00", borderColor: "#ffcccc" }}>✕ слайд</button>
                        )}
                    </div>
                    {(slide.content || []).map((blk, bi) => (
                        <BlockEditor key={blk.id} block={blk}
                            isFirst={bi === 0} isLast={bi === slide.content.length - 1}
                            onUpdate={b => updSlideBlock(activeSlide, bi, b)}
                            onRemove={() => rmSlideBlock(activeSlide, bi)}
                            onMoveUp={() => moveSlideBlock(activeSlide, bi, -1)}
                            onMoveDown={() => moveSlideBlock(activeSlide, bi, 1)}
                        />
                    ))}
                    <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                        {SLIDE_BLOCK_TYPES.map(({ type, label }) => (
                            <button key={type} onClick={() => addSlideBlock(activeSlide, type)}
                                style={{ background: "#f5f2eb", border: "1.5px dashed #ccc", borderRadius: 6, padding: "4px 10px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", color: "#666" }}>
                                {label}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

export default function TrainingPage({ onBack }) {
    const { profile, logout } = useAuth();
    const isAdmin = profile?.role === "admin";

    const [sections, setSections] = useState([]);
    const [loading, setLoading] = useState(true);
    const [activeId, setActiveId] = useState(null);
    const [expanded, setExpanded] = useState({});
    const [editMode, setEditMode] = useState(false);
    const [editSections, setEditSections] = useState([]);
    const [editActive, setEditActive] = useState({ si: 0, subi: null });
    const [editExpanded, setEditExpanded] = useState({});
    const [saving, setSaving] = useState(false);
    const [saveMsg, setSaveMsg] = useState("");
    const [showTests, setShowTests] = useState(false);

    useEffect(() => {
        const id = "training-content-css";
        if (!document.getElementById(id)) {
            const el = document.createElement("style");
            el.id = id;
            el.textContent = `
                .tr-html ul,.tr-html ol{margin:8px 0 10px 22px;padding:0}
                .tr-html ul{list-style:disc}
                .tr-html ol{list-style:decimal}
                .tr-html li{margin:3px 0;line-height:1.8}
                .tr-html h2{font-size:1.3em;font-weight:700;margin:16px 0 6px;color:#1a1a14}
                .tr-html [style*="text-align"]{display:block}
                .tr-html h3{font-size:1.08em;font-weight:700;margin:12px 0 5px;color:#1a1a14}
                .tr-html h4{font-size:1em;font-weight:700;margin:10px 0 4px;color:#3a3a2e}
                .tr-html p{margin:5px 0}
                .tr-html div{min-height:1em}
            `;
            document.head.appendChild(el);
        }
    }, []);

    useEffect(() => { loadSections(); }, []);

    // Firestore disallows arrays directly nested inside arrays, so table rows (array of
    // arrays) are stored as an array of {cells: [...]} objects instead. Carousel slides can
    // themselves contain table blocks, so this conversion has to recurse into slide content too.
    const deserializeBlocks = (blocks) => (blocks || []).map(block => {
        if (block.type === "table") {
            return {
                ...block,
                rows: (block.rows || []).map(row => (Array.isArray(row) ? row : (Array.isArray(row?.cells) ? row.cells : []))),
            };
        }
        if (block.type === "carousel") {
            return {
                ...block,
                slides: (block.slides || []).map(slide => ({ ...slide, content: deserializeBlocks(slide.content) })),
            };
        }
        return block;
    });

    const serializeBlocks = (blocks) => (blocks || []).map(block => {
        if (block.type === "table") {
            return { ...block, rows: (block.rows || []).map(row => ({ cells: row })) };
        }
        if (block.type === "carousel") {
            return {
                ...block,
                slides: (block.slides || []).map(slide => ({ ...slide, content: serializeBlocks(slide.content) })),
            };
        }
        return block;
    });

    const deserializeSection = (raw) => ({
        ...raw,
        subsections: (raw.subsections || []).map(sub => ({ ...sub, content: deserializeBlocks(sub.content) })),
    });

    const serializeSection = (sec) => ({
        ...sec,
        subsections: (sec.subsections || []).map(sub => ({ ...sub, content: serializeBlocks(sub.content) })),
    });

    const loadSections = async () => {
        setLoading(true);
        try {
            const snap = await getDocs(query(collection(db, "training_sections"), orderBy("order")));
            const data = snap.docs.map(d => deserializeSection({ id: d.id, ...d.data() }));
            setSections(data);
            if (data.length > 0) {
                const first = data[0];
                setExpanded({ [first.id]: true });
                setActiveId({ sectionId: first.id, subsectionId: first.subsections?.[0]?.id ?? null });
            }
        } finally {
            setLoading(false);
        }
    };

    const saveEdit = async () => {
        setSaving(true);
        setSaveMsg("");
        try {
            const existingIds = new Set(sections.map(s => s.id));
            const keepIds = new Set(editSections.filter(s => !s._new).map(s => s.id));
            for (const id of existingIds) {
                if (!keepIds.has(id)) await deleteDoc(doc(db, "training_sections", id));
            }
            const saved = [];
            for (let i = 0; i < editSections.length; i++) {
                const { _new, id, ...raw } = editSections[i];
                raw.order = i + 1;
                const data = serializeSection(raw);
                if (_new) {
                    const ref = await addDoc(collection(db, "training_sections"), data);
                    saved.push({ ...editSections[i], id: ref.id, _new: false });
                } else {
                    await setDoc(doc(db, "training_sections", id), data);
                    saved.push({ ...editSections[i], _new: false });
                }
            }
            setSections(JSON.parse(JSON.stringify(saved)));
            setEditSections(saved);
            setSaveMsg("ok");
            setTimeout(() => setSaveMsg(""), 2500);
        } catch (e) {
            console.error(e);
            setSaveMsg("error");
            setTimeout(() => setSaveMsg(""), 3000);
        }
        setSaving(false);
    };

    const exitEdit = () => {
        setEditMode(false);
        setSaveMsg("");
    };

    const startEdit = () => {
        const copy = JSON.parse(JSON.stringify(sections));
        setEditSections(copy);
        const exp = {};
        copy.forEach(s => { exp[s.id] = true; });
        setEditExpanded(exp);
        setEditActive({ si: 0, subi: copy[0]?.subsections?.length ? 0 : null });
        setEditMode(true);
    };

    // ── Edit helpers ──────────────────────────────────────────────────────────

    const updSec = (i, patch) =>
        setEditSections(p => p.map((s, j) => j === i ? { ...s, ...patch } : s));

    const updSub = (si, subi, patch) =>
        setEditSections(p => p.map((s, i) => i !== si ? s : {
            ...s, subsections: s.subsections.map((sub, j) => j !== subi ? sub : { ...sub, ...patch })
        }));

    const updBlock = (si, subi, bi, blk) =>
        setEditSections(p => p.map((s, i) => i !== si ? s : {
            ...s, subsections: s.subsections.map((sub, j) => j !== subi ? sub : {
                ...sub, content: sub.content.map((b, k) => k !== bi ? b : blk)
            })
        }));

    const moveBlock = (si, subi, bi, dir) =>
        setEditSections(p => p.map((s, i) => i !== si ? s : {
            ...s, subsections: s.subsections.map((sub, j) => {
                if (j !== subi) return sub;
                const c = [...sub.content];
                const t = bi + dir;
                if (t < 0 || t >= c.length) return sub;
                [c[bi], c[t]] = [c[t], c[bi]];
                return { ...sub, content: c };
            })
        }));

    const addBlock = (si, subi, type) =>
        setEditSections(p => p.map((s, i) => i !== si ? s : {
            ...s, subsections: s.subsections.map((sub, j) => j !== subi ? sub : {
                ...sub, content: [...(sub.content || []), NEW_BLOCK[type]()]
            })
        }));

    const rmBlock = (si, subi, bi) =>
        setEditSections(p => p.map((s, i) => i !== si ? s : {
            ...s, subsections: s.subsections.map((sub, j) => j !== subi ? sub : {
                ...sub, content: sub.content.filter((_, k) => k !== bi)
            })
        }));

    const addSub = (si) => {
        const sub = { id: genId(), title: "Новий підрозділ", content: [] };
        setEditSections(p => p.map((s, i) => i !== si ? s : {
            ...s, subsections: [...(s.subsections || []), sub]
        }));
    };

    const rmSub = (si, subi) =>
        setEditSections(p => p.map((s, i) => i !== si ? s : {
            ...s, subsections: s.subsections.filter((_, j) => j !== subi)
        }));

    const moveSub = (si, subi, dir) =>
        setEditSections(p => p.map((s, i) => {
            if (i !== si) return s;
            const subs = [...s.subsections];
            const t = subi + dir;
            if (t < 0 || t >= subs.length) return s;
            [subs[subi], subs[t]] = [subs[t], subs[subi]];
            return { ...s, subsections: subs };
        }));

    const addSec = () =>
        setEditSections(p => [...p, { _new: true, id: genId(), title: "Новий розділ", order: p.length + 1, subsections: [] }]);

    const rmSec = (si) =>
        setEditSections(p => p.filter((_, i) => i !== si));

    const moveSec = (si, dir) =>
        setEditSections(p => {
            const arr = [...p];
            const t = si + dir;
            if (t < 0 || t >= arr.length) return p;
            [arr[si], arr[t]] = [arr[t], arr[si]];
            return arr;
        });

    const getActive = () => {
        if (!activeId) return null;
        const sec = sections.find(s => s.id === activeId.sectionId);
        if (!sec) return null;
        const sub = sec.subsections?.find(s => s.id === activeId.subsectionId) ?? null;
        return { sec, sub };
    };

    const toggleExpand = (id) => setExpanded(p => ({ ...p, [id]: !p[id] }));

    if (showTests) return <TrainingTests onBack={() => setShowTests(false)} />;

    const headerBtn = { background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontFamily: "inherit", fontSize: 12 };
    const primBtn = { background: "#e8ff47", color: "#1a1a14", border: "none", borderRadius: 6, padding: "7px 20px", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700 };

    const exportTxt = () => {
        const stripHtml = (html) => {
            const div = document.createElement("div");
            div.innerHTML = html || "";
            return (div.innerText || div.textContent || "").trim();
        };
        const lines = [];
        sections.forEach((sec, si) => {
            lines.push(`${"=".repeat(60)}`);
            lines.push(`РОЗДІЛ ${si + 1}: ${sec.title}`);
            lines.push(`${"=".repeat(60)}`);
            lines.push("");
            (sec.subsections || []).forEach((sub, subi) => {
                lines.push(`${si + 1}.${subi + 1}  ${sub.title}`);
                lines.push(`${"-".repeat(40)}`);
                (sub.content || []).forEach(block => {
                    if (block.type === "text") {
                        lines.push(stripHtml(block.value));
                        lines.push("");
                    } else if (block.type === "image") {
                        lines.push(`[Зображення${block.caption ? ": " + block.caption : ""}]`);
                        lines.push("");
                    } else if (block.type === "video") {
                        lines.push(`[Відео${block.caption ? ": " + block.caption : ""}]`);
                        lines.push("");
                    } else if (block.type === "drive") {
                        lines.push(`[Файл Google Drive${block.caption ? ": " + block.caption : ""}]`);
                        lines.push("");
                    } else if (block.type === "table" && block.headers?.length) {
                        if (block.caption) lines.push(block.caption);
                        lines.push(block.headers.join(" | "));
                        lines.push("-".repeat(block.headers.join(" | ").length));
                        (block.rows || []).forEach(row => lines.push(row.join(" | ")));
                        lines.push("");
                    }
                });
                lines.push("");
            });
        });
        const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "навчання.txt";
        a.click();
        URL.revokeObjectURL(url);
    };

    return (
        <div style={{ minHeight: "100vh", background: "#f5f2eb", fontFamily: "Georgia, serif" }}>
            {/* Header */}
            <div style={{ background: "#1a1a14", color: "#e8ff47", padding: "14px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", position: "sticky", top: 0, zIndex: 100 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                    {onBack && <button onClick={onBack} style={headerBtn}>← Назад</button>}
                    <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: 3 }}>ACADEM — НАВЧАННЯ</span>
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    {isAdmin && !editMode && (
                        <button onClick={startEdit} style={{ ...headerBtn, color: "#e8ff47", borderColor: "#888" }}>Редагувати</button>
                    )}
                    {isAdmin && editMode && (
                        <>
                            {saveMsg === "ok" && <span style={{ fontSize: 12, color: "#e8ff47" }}>✓ Збережено</span>}
                            {saveMsg === "error" && <span style={{ fontSize: 12, color: "#ff6b6b" }}>✕ Помилка збереження</span>}
                            <button onClick={exitEdit} style={headerBtn}>← Вийти</button>
                            <button onClick={saveEdit} disabled={saving} style={{ ...primBtn, opacity: saving ? 0.6 : 1 }}>
                                {saving ? "Збереження..." : "Зберегти"}
                            </button>
                        </>
                    )}
                    {isAdmin && !editMode && sections.length > 0 && (
                        <button onClick={exportTxt} style={headerBtn}>↓ TXT</button>
                    )}
                    {!editMode && (
                        <button onClick={() => setShowTests(true)} style={primBtn}>Тести →</button>
                    )}
                    {!isAdmin && !editMode && (
                        <button onClick={logout} style={headerBtn}>Вийти</button>
                    )}
                </div>
            </div>

            {loading ? (
                <div style={{ padding: 60, textAlign: "center", color: "#888", fontSize: 14 }}>Завантаження...</div>
            ) : editMode ? (
                /* ── EDITOR (sidebar + content) ── */
                <div style={{ maxWidth: 1200, margin: "0 auto", padding: "32px 20px", display: "flex", gap: 24, alignItems: "flex-start" }}>
                    {/* Edit sidebar */}
                    <div style={{ width: 230, flexShrink: 0, position: "sticky", top: 24, maxHeight: "calc(100vh - 100px)", display: "flex", flexDirection: "column" }}>
                        <div style={{ background: "#fff", borderRadius: 12, boxShadow: "0 2px 12px rgba(0,0,0,0.06)", flex: 1, overflowY: "auto", paddingBottom: 8 }}>
                            {editSections.length === 0 ? (
                                <div style={{ padding: "20px 16px", color: "#aaa", fontSize: 13 }}>Немає розділів</div>
                            ) : editSections.map((sec, si) => (
                                <div key={sec.id}>
                                    <div
                                        onClick={() => {
                                            setEditExpanded(p => ({ ...p, [sec.id]: !p[sec.id] }));
                                            setEditActive({ si, subi: null });
                                        }}
                                        style={{
                                            padding: "10px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
                                            background: editActive.si === si && editActive.subi === null ? "#f0ece2" : "transparent",
                                            borderLeft: editActive.si === si && editActive.subi === null ? "3px solid #1a1a14" : "3px solid transparent",
                                            transition: "all .12s",
                                        }}
                                    >
                                        <span style={{ fontSize: 10, color: "#bbb", minWidth: 10 }}>{editExpanded[sec.id] ? "▾" : "▸"}</span>
                                        <span style={{ fontSize: 13, fontWeight: 600, color: "#333", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                            {sec.title || "Без назви"}
                                        </span>
                                    </div>
                                    {editExpanded[sec.id] && (sec.subsections || []).map((sub, subi) => (
                                        <div
                                            key={sub.id}
                                            onClick={() => setEditActive({ si, subi })}
                                            style={{
                                                padding: "8px 14px 8px 34px", cursor: "pointer", fontSize: 12,
                                                color: editActive.si === si && editActive.subi === subi ? "#1a1a14" : "#888",
                                                background: editActive.si === si && editActive.subi === subi ? "#eef5d8" : "transparent",
                                                borderLeft: editActive.si === si && editActive.subi === subi ? "3px solid #8ac040" : "3px solid transparent",
                                                fontWeight: editActive.si === si && editActive.subi === subi ? 600 : 400,
                                                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                                transition: "all .12s",
                                            }}
                                        >
                                            {sub.title || "Без назви"}
                                        </div>
                                    ))}
                                </div>
                            ))}
                        </div>
                        <button onClick={() => {
                            addSec();
                            setEditActive({ si: editSections.length, subi: null });
                        }} style={{ marginTop: 10, width: "100%", background: "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 8, padding: "9px 0", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                            + Додати розділ
                        </button>
                    </div>

                    {/* Edit content panel */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                        {editSections.length === 0 ? (
                            <div style={{ background: "#fff", borderRadius: 12, padding: 40, textAlign: "center", color: "#aaa", fontSize: 14, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                                Натисніть «+ Додати розділ» щоб почати
                            </div>
                        ) : (() => {
                            const { si, subi } = editActive;
                            const sec = editSections[si];
                            if (!sec) return null;

                            /* ── Section editor ── */
                            if (subi === null) return (
                                <div style={{ background: "#fff", borderRadius: 12, padding: 28, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 24, paddingBottom: 16, borderBottom: "1.5px solid #f0ece2" }}>
                                        <span style={{ fontSize: 10, color: "#888", background: "#f0ece2", padding: "2px 10px", borderRadius: 4, textTransform: "uppercase", letterSpacing: 1, fontFamily: "inherit" }}>
                                            Розділ {si + 1}
                                        </span>
                                        <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                                            {si > 0 && <button onClick={() => { moveSec(si, -1); setEditActive({ si: si - 1, subi: null }); }} style={miniBtn}>↑</button>}
                                            {si < editSections.length - 1 && <button onClick={() => { moveSec(si, 1); setEditActive({ si: si + 1, subi: null }); }} style={miniBtn}>↓</button>}
                                            <button onClick={() => { if (window.confirm("Видалити розділ?")) { rmSec(si); setEditActive({ si: Math.max(0, si - 1), subi: null }); } }} style={{ ...miniBtn, color: "#c00", borderColor: "#ffcccc" }}>✕ Видалити</button>
                                        </div>
                                    </div>
                                    <div style={{ marginBottom: 28 }}>
                                        <label style={{ fontSize: 11, color: "#aaa", textTransform: "uppercase", letterSpacing: 1 }}>Назва розділу</label>
                                        <input
                                            value={sec.title}
                                            onChange={e => updSec(si, { title: e.target.value })}
                                            style={{ display: "block", width: "100%", fontSize: 20, fontWeight: 700, fontFamily: "Georgia, serif", border: "none", borderBottom: "2px solid #e0ddd4", background: "transparent", padding: "6px 0", outline: "none", color: "#1a1a14", boxSizing: "border-box", marginTop: 6 }}
                                        />
                                    </div>
                                    <div>
                                        <div style={{ fontSize: 11, color: "#aaa", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>Підрозділи</div>
                                        {(sec.subsections || []).length === 0 && (
                                            <div style={{ color: "#ccc", fontSize: 13, marginBottom: 12 }}>Немає підрозділів</div>
                                        )}
                                        {(sec.subsections || []).map((sub, subi) => (
                                            <div key={sub.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", background: "#faf8f3", borderRadius: 8, marginBottom: 6 }}>
                                                <span style={{ flex: 1, fontSize: 13, color: "#333", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub.title || "Без назви"}</span>
                                                <button onClick={() => setEditActive({ si, subi })} style={{ ...miniBtn, color: "#555" }}>Редагувати →</button>
                                                {subi > 0 && <button onClick={() => moveSub(si, subi, -1)} style={miniBtn}>↑</button>}
                                                {subi < sec.subsections.length - 1 && <button onClick={() => moveSub(si, subi, 1)} style={miniBtn}>↓</button>}
                                                <button onClick={() => { if (window.confirm("Видалити підрозділ?")) rmSub(si, subi); }} style={{ ...miniBtn, color: "#c00" }}>✕</button>
                                            </div>
                                        ))}
                                        <button onClick={() => {
                                            addSub(si);
                                            setEditExpanded(p => ({ ...p, [sec.id]: true }));
                                            setTimeout(() => setEditActive({ si, subi: (sec.subsections || []).length }), 0);
                                        }} style={{ background: "transparent", border: "1.5px dashed #ccc", borderRadius: 7, padding: "7px 16px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", color: "#888", marginTop: 4 }}>
                                            + Додати підрозділ
                                        </button>
                                    </div>
                                </div>
                            );

                            /* ── Subsection editor ── */
                            const sub = sec.subsections?.[subi];
                            if (!sub) return null;
                            return (
                                <div style={{ background: "#fff", borderRadius: 12, padding: 28, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20, paddingBottom: 16, borderBottom: "1.5px solid #f0ece2" }}>
                                        <button onClick={() => setEditActive({ si, subi: null })} style={{ ...miniBtn, fontSize: 12 }}>← {sec.title}</button>
                                        <span style={{ fontSize: 10, color: "#888", background: "#fdf9e8", padding: "2px 8px", borderRadius: 4, textTransform: "uppercase", letterSpacing: 1, fontFamily: "inherit" }}>Підрозділ</span>
                                        <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                                            {subi > 0 && <button onClick={() => { moveSub(si, subi, -1); setEditActive({ si, subi: subi - 1 }); }} style={miniBtn}>↑</button>}
                                            {subi < sec.subsections.length - 1 && <button onClick={() => { moveSub(si, subi, 1); setEditActive({ si, subi: subi + 1 }); }} style={miniBtn}>↓</button>}
                                            <button onClick={() => { if (window.confirm("Видалити підрозділ?")) { rmSub(si, subi); setEditActive({ si, subi: null }); } }} style={{ ...miniBtn, color: "#c00", borderColor: "#ffcccc" }}>✕ Видалити</button>
                                        </div>
                                    </div>
                                    <div style={{ marginBottom: 20 }}>
                                        <label style={{ fontSize: 11, color: "#aaa", textTransform: "uppercase", letterSpacing: 1 }}>Назва підрозділу</label>
                                        <input
                                            value={sub.title}
                                            onChange={e => updSub(si, subi, { title: e.target.value })}
                                            style={{ display: "block", width: "100%", fontSize: 16, fontWeight: 600, fontFamily: "Georgia, serif", border: "none", borderBottom: "2px solid #e0ddd4", background: "transparent", padding: "5px 0", outline: "none", color: "#1a1a14", boxSizing: "border-box", marginTop: 6 }}
                                        />
                                    </div>
                                    {(sub.content || []).map((blk, bi) => (
                                        <BlockEditor
                                            key={blk.id}
                                            block={blk}
                                            isFirst={bi === 0}
                                            isLast={bi === sub.content.length - 1}
                                            onUpdate={b => updBlock(si, subi, bi, b)}
                                            onRemove={() => rmBlock(si, subi, bi)}
                                            onMoveUp={() => moveBlock(si, subi, bi, -1)}
                                            onMoveDown={() => moveBlock(si, subi, bi, 1)}
                                        />
                                    ))}
                                    <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                                        {BLOCK_TYPES.map(({ type, label }) => (
                                            <button key={type} onClick={() => addBlock(si, subi, type)}
                                                style={{ background: "#f5f2eb", border: "1.5px dashed #ccc", borderRadius: 6, padding: "5px 12px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", color: "#666" }}>
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            );
                        })()}
                    </div>
                </div>
            ) : (
                /* ── READING VIEW ── */
                <div style={{ maxWidth: 1200, margin: "0 auto", padding: "32px 20px", display: "flex", gap: 28, alignItems: "flex-start" }}>
                    {/* Sidebar */}
                    <div style={{ width: 240, flexShrink: 0, position: "sticky", top: 24 }}>
                        <div style={{ background: "#fff", borderRadius: 12, paddingTop: 8, paddingBottom: 8, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                            {sections.length === 0 ? (
                                <div style={{ padding: "20px", color: "#aaa", fontSize: 13 }}>
                                    {isAdmin ? "Натисніть «Редагувати» щоб додати контент." : "Контент ще не додано."}
                                </div>
                            ) : sections.map(sec => (
                                <div key={sec.id}>
                                    <div
                                        onClick={() => {
                                            toggleExpand(sec.id);
                                            const firstSub = sec.subsections?.[0];
                                            setActiveId({ sectionId: sec.id, subsectionId: firstSub?.id ?? null });
                                        }}
                                        style={{
                                            padding: "10px 18px", cursor: "pointer", fontWeight: 600, fontSize: 13,
                                            color: activeId?.sectionId === sec.id ? "#1a1a14" : "#555",
                                            background: activeId?.sectionId === sec.id && !activeId?.subsectionId ? "#f0ece2" : "transparent",
                                            borderLeft: activeId?.sectionId === sec.id && !activeId?.subsectionId ? "3px solid #1a1a14" : "3px solid transparent",
                                            display: "flex", alignItems: "center", gap: 8, transition: "all .15s",
                                        }}
                                    >
                                        <span style={{ fontSize: 10, color: "#bbb", minWidth: 10 }}>{expanded[sec.id] ? "▾" : "▸"}</span>
                                        {sec.title}
                                    </div>
                                    {expanded[sec.id] && (sec.subsections || []).map(sub => (
                                        <div
                                            key={sub.id}
                                            onClick={() => setActiveId({ sectionId: sec.id, subsectionId: sub.id })}
                                            style={{
                                                padding: "8px 18px 8px 38px", cursor: "pointer", fontSize: 12,
                                                color: activeId?.subsectionId === sub.id ? "#1a1a14" : "#888",
                                                background: activeId?.subsectionId === sub.id ? "#eef5d8" : "transparent",
                                                borderLeft: activeId?.subsectionId === sub.id ? "3px solid #8ac040" : "3px solid transparent",
                                                fontWeight: activeId?.subsectionId === sub.id ? 600 : 400,
                                                transition: "all .15s",
                                            }}
                                        >
                                            {sub.title}
                                        </div>
                                    ))}
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Content */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                        {!activeId ? (
                            <div style={{ padding: "40px 0", color: "#aaa", fontSize: 14 }}>Оберіть розділ</div>
                        ) : (() => {
                            const active = getActive();
                            if (!active) return null;
                            const { sec, sub } = active;
                            return (
                                <div style={{ background: "#fff", borderRadius: 12, padding: 32, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                                    <div style={{ fontSize: 11, color: "#aaa", letterSpacing: 2, textTransform: "uppercase", marginBottom: 6, fontFamily: "inherit" }}>{sec.title}</div>
                                    <h2 style={{ fontSize: 22, fontWeight: 700, color: "#1a1a14", margin: "0 0 28px 0", borderBottom: "2px solid #f0ece2", paddingBottom: 16 }}>
                                        {sub?.title || sec.title}
                                    </h2>
                                    <ContentErrorBoundary key={`${sec.id}:${sub?.id || ""}`}>
                                        <ContentView blocks={sub?.content || []} />
                                    </ContentErrorBoundary>
                                </div>
                            );
                        })()}
                    </div>
                </div>
            )}
        </div>
    );
}
