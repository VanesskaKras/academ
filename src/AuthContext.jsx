import { createContext, useContext, useEffect, useRef, useState } from "react";
import { auth, db } from "./firebase";
import {
    signInWithEmailAndPassword,
    signOut,
    onAuthStateChanged,
} from "firebase/auth";
import { doc, onSnapshot, setDoc, updateDoc, getDoc, addDoc, collection } from "firebase/firestore";

const SESSION_KEY = "academ_session_id";
export const KICKED_KEY = "academ_kicked";

const AuthContext = createContext();

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [profile, setProfile] = useState(null);
    const [loading, setLoading] = useState(true);
    const profileUnsubRef = useRef(null);

    useEffect(() => {
        const unsub = onAuthStateChanged(auth, (u) => {
            setUser(u);

            if (profileUnsubRef.current) {
                profileUnsubRef.current();
                profileUnsubRef.current = null;
            }

            if (u) {
                const ref = doc(db, "users", u.uid);
                let initialized = false;

                const unsubProfile = onSnapshot(ref, async (snap) => {
                    if (snap.exists()) {
                        const data = snap.data();

                        const storedSession = localStorage.getItem(SESSION_KEY);
                        if (storedSession && data.sessionId && data.sessionId !== storedSession) {
                            localStorage.removeItem(SESSION_KEY);
                            localStorage.setItem(KICKED_KEY, "1");
                            signOut(auth);
                            return;
                        }

                        setProfile(data);
                    } else {
                        setProfile(null);
                    }

                    if (!initialized) {
                        initialized = true;
                        setLoading(false);
                    }
                });

                profileUnsubRef.current = unsubProfile;
            } else {
                setProfile(null);
                setLoading(false);
            }
        });

        return () => {
            unsub();
            if (profileUnsubRef.current) profileUnsubRef.current();
        };
    }, []);

    const login = async (email, password) => {
        localStorage.removeItem(SESSION_KEY);
        const cred = await signInWithEmailAndPassword(auth, email, password);

        const sessionId = crypto.randomUUID
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

        localStorage.removeItem(KICKED_KEY);

        const userRef = doc(db, "users", cred.user.uid);
        const userSnap = await getDoc(userRef);
        if (userSnap.exists()) {
            await updateDoc(userRef, { sessionId });
        } else {
            await setDoc(userRef, {
                email: cred.user.email,
                name: cred.user.email.split("@")[0],
                role: "user",
                approved: true,
                blocked: false,
                createdAt: new Date().toISOString(),
                sessionId,
            });
        }

        try {
            await addDoc(collection(db, "loginLogs"), {
                uid: cred.user.uid,
                email: cred.user.email,
                sessionId,
                timestamp: new Date().toISOString(),
                userAgent: navigator.userAgent,
            });
        } catch (e) {
            console.error("Login log error:", e);
        }

        localStorage.setItem(SESSION_KEY, sessionId);
        return cred;
    };

    const logout = () => {
        localStorage.removeItem(SESSION_KEY);
        return signOut(auth);
    };

    return (
        <AuthContext.Provider value={{ user, profile, login, logout, loading }}>
            {!loading && children}
        </AuthContext.Provider>
    );
}

export const useAuth = () => useContext(AuthContext);
