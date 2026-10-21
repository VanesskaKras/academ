import { useState, useEffect } from "react";
import { AuthProvider, useAuth } from "./AuthContext";
import LoginPage from "./LoginPage";
import AdminPage from "./AdminPage";
import Dashboard from "./Dashboard";
import AcademAssist from "./academic-assistant";
import SmallWorks from "./small-works";
import TrainingPage from "./TrainingPage";
import FileCorrectionsPage from "./FileCorrectionsPage";
import PracticePage from "./PracticePage";

function AppRouter() {
  const { user, profile } = useAuth();
  const [view, setView] = useState(() => sessionStorage.getItem("appView") || "dashboard");
  const [currentOrderId, setCurrentOrderId] = useState(() => sessionStorage.getItem("appOrderId") || null);
  const [currentMode, setCurrentMode] = useState(() => sessionStorage.getItem("appMode") || "large");

  useEffect(() => { sessionStorage.setItem("appView", view); }, [view]);
  useEffect(() => {
    if (currentOrderId) sessionStorage.setItem("appOrderId", currentOrderId);
    else sessionStorage.removeItem("appOrderId");
  }, [currentOrderId]);
  useEffect(() => { sessionStorage.setItem("appMode", currentMode); }, [currentMode]);

  if (!user) return <LoginPage />;

  if (profile?.blocked) {
    return (
      <div style={{ minHeight: "100vh", background: "#f5f2eb", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Georgia, serif" }}>
        <div style={{ textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>🚫</div>
          <div style={{ fontSize: 18, color: "#c00", marginBottom: 8 }}>Доступ заблоковано</div>
          <div style={{ fontSize: 14, color: "#888" }}>Зверніться до адміністратора</div>
        </div>
      </div>
    );
  }

  // Trainee: only training access
  if (profile?.role === "user") {
    return <TrainingPage />;
  }

  // Невідома/відсутня роль (видалений профіль, ще не створений документ, помилка
  // Firestore) — за замовчуванням БЛОКУЄМО доступ, а не пускаємо в повний Dashboard.
  if (profile?.role !== "manager" && profile?.role !== "admin") {
    return (
      <div style={{ minHeight: "100vh", background: "#f5f2eb", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Georgia, serif" }}>
        <div style={{ textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>⏳</div>
          <div style={{ fontSize: 18, color: "#c00", marginBottom: 8 }}>Профіль не знайдено</div>
          <div style={{ fontSize: 14, color: "#888" }}>Спробуйте перезайти або зверніться до адміністратора</div>
        </div>
      </div>
    );
  }

  if (view === "admin" && profile?.role === "admin") {
    return <AdminPage onBack={() => setView("dashboard")} />;
  }

  if (view === "training") {
    return <TrainingPage onBack={() => setView("dashboard")} />;
  }

  if (view === "file-corrections") {
    return <FileCorrectionsPage onBack={() => setView("dashboard")} />;
  }

  if (view === "order") {
    if (currentMode === "file_corrections") {
      return <FileCorrectionsPage onBack={() => { setCurrentOrderId(null); setView("dashboard"); }} />;
    }
    if (currentMode === "practice") {
      return (
        <PracticePage
          orderId={currentOrderId}
          onOrderCreated={(id) => setCurrentOrderId(id)}
          onBack={() => { setCurrentOrderId(null); setView("dashboard"); }}
        />
      );
    }
    if (currentMode === "small") {
      return (
        <SmallWorks
          orderId={currentOrderId}
          onOrderCreated={(id) => setCurrentOrderId(id)}
          onBack={() => { setCurrentOrderId(null); setView("dashboard"); }}
        />
      );
    }
    return (
      <AcademAssist
        orderId={currentOrderId}
        onOrderCreated={(id) => setCurrentOrderId(id)}
        onBack={() => { setCurrentOrderId(null); setView("dashboard"); }}
      />
    );
  }

  return (
    <Dashboard
      onOpen={(id, mode) => { setCurrentOrderId(id); setCurrentMode(mode || "large"); setView("order"); }}
      onNew={(mode) => { setCurrentOrderId(null); setCurrentMode(mode || "large"); setView("order"); }}
      onAdmin={profile?.role === "admin" ? () => setView("admin") : null}
      onTraining={() => setView("training")}
      onFileCorrections={() => setView("file-corrections")}
    />
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRouter />
    </AuthProvider>
  );
}
