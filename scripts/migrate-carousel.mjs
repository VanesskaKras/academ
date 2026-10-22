// Usage (run from the academ-assist project root):
//   node --env-file=.env.local scripts/migrate-carousel.mjs                 (dry run)
//   node --env-file=.env.local scripts/migrate-carousel.mjs --confirm       (writes to Firestore)
//
// Requires env vars (set in shell, NOT committed):
//   ADMIN_EMAIL, ADMIN_PASSWORD  -- an account with role:"admin" in Firestore
// Plus the existing VITE_FIREBASE_* vars from .env.local (loaded automatically via --env-file).

import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import { getFirestore, collection, getDocs, query, orderBy, doc, setDoc, terminate } from "firebase/firestore";
import { readFileSync } from "node:fs";

const SECTION_TITLE_MATCH = "теорія: види студентських робіт";
const SUBSECTION_TITLE_MATCH = "наповнення робіт";
const CONFIRM = process.argv.includes("--confirm");

function genId() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

async function main() {
    const firebaseConfig = {
        apiKey: process.env.VITE_FIREBASE_API_KEY,
        authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
        projectId: process.env.VITE_FIREBASE_PROJECT_ID,
        storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
        messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
        appId: process.env.VITE_FIREBASE_APP_ID,
    };

    if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
        throw new Error("Missing VITE_FIREBASE_* env vars. Run with: node --env-file=.env.local scripts/migrate-carousel.mjs");
    }
    if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
        throw new Error("Missing ADMIN_EMAIL / ADMIN_PASSWORD env vars.");
    }

    const generatedSlides = JSON.parse(readFileSync(new URL("./carousel-slides.json", import.meta.url), "utf8"));

    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const db = getFirestore(app);

    try {
        await signInWithEmailAndPassword(auth, process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
        console.log("Signed in as", process.env.ADMIN_EMAIL);

        const snap = await getDocs(query(collection(db, "training_sections"), orderBy("order")));
        const sections = snap.docs.map(d => ({ id: d.id, ...d.data() }));

        const section = sections.find(s => (s.title || "").trim().toLowerCase() === SECTION_TITLE_MATCH);
        if (!section) {
            console.error("Section not found. Available sections:");
            for (const s of sections) console.error(" -", JSON.stringify(s.title));
            return;
        }

        let subsections = section.subsections || [];
        let subIdx = subsections.findIndex(sub => (sub.title || "").trim().toLowerCase() === SUBSECTION_TITLE_MATCH);
        const creatingSubsection = subIdx === -1;
        if (creatingSubsection) {
            console.log(`Subsection "${SUBSECTION_TITLE_MATCH}" not found in "${section.title}" -- will create it.`);
            console.log("Existing subsections:");
            for (const sub of subsections) console.log(" -", JSON.stringify(sub.title));
            subsections = [...subsections, { id: genId(), title: "Наповнення робіт", content: [] }];
            subIdx = subsections.length - 1;
        }

        const sub = subsections[subIdx];
        const content = sub.content || [];
        const carouselIdx = content.findIndex(b => b.type === "carousel");
        const existingCarousel = carouselIdx !== -1 ? content[carouselIdx] : null;
        const existingSlides = existingCarousel ? (existingCarousel.slides || []) : [];

        // Existing slides with real (non-empty) content are preserved as-is.
        // Existing slides with no content (just a title, e.g. an unfinished manual draft) get filled in.
        // Specialties not yet present as slides are appended.
        const existingByTitle = new Map(existingSlides.map(s => [(s.title || "").trim(), s]));

        const finalSlides = [];
        const report = { kept: [], filled: [], added: [] };

        for (const slide of existingSlides) {
            const title = (slide.title || "").trim();
            const gen = generatedSlides.find(g => g.title === title);
            const hasContent = (slide.content || []).length > 0;
            if (hasContent || !gen) {
                finalSlides.push(slide);
                report.kept.push(title);
            } else {
                finalSlides.push({ ...slide, content: gen.content });
                report.filled.push(title);
            }
        }
        for (const gen of generatedSlides) {
            if (!existingByTitle.has(gen.title)) {
                finalSlides.push(gen);
                report.added.push(gen.title);
            }
        }

        console.log(`\nSection: "${section.title}"  >  Subsection: "${sub.title}"`);
        console.log(`Existing slides: ${existingSlides.length}, final slides: ${finalSlides.length}`);
        console.log(`Kept (untouched, had content):`, report.kept.length ? report.kept : "(none)");
        console.log(`Filled (existing empty slide -> table content):`, report.filled.length ? report.filled : "(none)");
        console.log(`Added (new slides):`, report.added.length);

        if (!CONFIRM) {
            console.log("\nDry run only. Re-run with --confirm to write to Firestore.");
            return;
        }

        const newCarouselBlock = existingCarousel
            ? { ...existingCarousel, slides: finalSlides }
            : { id: genId(), type: "carousel", slides: finalSlides };

        const newContent = carouselIdx !== -1
            ? content.map((b, i) => (i === carouselIdx ? newCarouselBlock : b))
            : [...content, newCarouselBlock];

        const newSubsections = subsections.map((s, i) => (i === subIdx ? { ...s, content: newContent } : s));

        // Firestore disallows arrays nested directly inside arrays, so table rows are stored as
        // {cells: [...]} objects. This must recurse into carousel slides too (matches the app's
        // serializeBlocks in TrainingPage.jsx).
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

        const serialized = {
            ...section,
            subsections: newSubsections.map(s => ({ ...s, content: serializeBlocks(s.content) })),
        };
        const { id, ...data } = serialized;

        await setDoc(doc(db, "training_sections", id), data);
        console.log("\nWritten to Firestore. Done.");
    } finally {
        // Close Firestore's network streams explicitly so Node can exit cleanly on Windows
        // (an abrupt process.exit() while gRPC/long-polling handles are still open crashes
        // libuv with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)").
        await terminate(db).catch(() => {});
    }
}

main()
    .then(() => { process.exitCode = 0; })
    .catch((err) => {
        console.error("\nFAILED:", err?.code || "", err?.message || err);
        process.exitCode = 1;
    });
