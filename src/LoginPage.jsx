import { useState, useEffect } from "react";
import { useAuth } from "./AuthContext";
import { KICKED_KEY } from "./AuthContext";

export default function LoginPage() {
    const { login } = useAuth();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const [kicked, setKicked] = useState(false);

    useEffect(() => {
        if (localStorage.getItem(KICKED_KEY) === "1") {
            setKicked(true);
            localStorage.removeItem(KICKED_KEY);
        }
    }, []);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError("");
        setLoading(true);
        try {
            await login(email, password);
        } catch (err) {
            setError(err.code || err.message || "Невірний email або пароль");
        }
        setLoading(false);
    };

    return (
        <div style={{ minHeight: "100vh", background: "#f5f2eb", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Georgia', serif" }}>
            <div style={{ width: 380, background: "#fff", borderRadius: 12, padding: 40, boxShadow: "0 4px 24px rgba(0,0,0,0.08)" }}>
                <div style={{ textAlign: "center", marginBottom: 32 }}>
                    <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: 3, color: "#1a1a14" }}>ACADEM</div>
                    <div style={{ fontSize: 13, color: "#888", marginTop: 4 }}>Система генерації наукових робіт</div>
                </div>
                <form onSubmit={handleSubmit}>
                    <div style={{ marginBottom: 16 }}>
                        <div style={{ fontSize: 11, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>Email</div>
                        <input
                            type="email" value={email} onChange={e => setEmail(e.target.value)} required
                            style={{ width: "100%", padding: "10px 14px", border: "1.5px solid #ddd", borderRadius: 7, fontSize: 14, boxSizing: "border-box", fontFamily: "inherit" }}
                        />
                    </div>
                    <div style={{ marginBottom: 24 }}>
                        <div style={{ fontSize: 11, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>Пароль</div>
                        <input
                            type="password" value={password} onChange={e => setPassword(e.target.value)} required
                            style={{ width: "100%", padding: "10px 14px", border: "1.5px solid #ddd", borderRadius: 7, fontSize: 14, boxSizing: "border-box", fontFamily: "inherit" }}
                        />
                    </div>
                    {kicked && (
                        <div style={{ background: "#fff8e4", border: "1px solid #f0c040", borderRadius: 6, padding: "10px 14px", color: "#7a5a00", fontSize: 13, marginBottom: 16 }}>
                            Сесію завершено — обліковий запис увійшов з іншого пристрою.
                        </div>
                    )}
                    {error && <div style={{ background: "#fff0f0", border: "1px solid #ffcccc", borderRadius: 6, padding: "10px 14px", color: "#c00", fontSize: 13, marginBottom: 16 }}>{error}</div>}
                    <button type="submit" disabled={loading}
                        style={{ width: "100%", padding: "12px", background: loading ? "#aaa" : "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 7, fontSize: 14, fontWeight: 700, letterSpacing: 1, cursor: loading ? "default" : "pointer" }}>
                        {loading ? "Вхід..." : "Увійти →"}
                    </button>
                </form>
                <div style={{ marginTop: 20, fontSize: 12, color: "#aaa", textAlign: "center" }}>
                    Доступ надається адміністратором
                </div>
            </div>
        </div>
    );
}