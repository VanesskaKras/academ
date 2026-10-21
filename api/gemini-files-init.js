import { requireAuth, applyCors } from "./_auth.js";

export const config = { maxDuration: 30 };

function getApiKey() {
    return [
        process.env.GEMINI_API_KEY_1,
        process.env.GEMINI_API_KEY_2,
        process.env.GEMINI_API_KEY_3,
        process.env.GEMINI_API_KEY,
    ].find(Boolean);
}

export default async function handler(req, res) {
    applyCors(req, res);
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).end();
    if (!(await requireAuth(req, res))) return;

    const key = getApiKey();
    if (!key) return res.status(500).json({ error: "No Gemini API key" });

    const { mimeType, fileSize } = req.body;

    const r = await fetch(
        `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=resumable&key=${key}`,
        {
            method: "POST",
            headers: {
                "X-Goog-Upload-Protocol": "resumable",
                "X-Goog-Upload-Command": "start",
                "X-Goog-Upload-Header-Content-Length": String(fileSize),
                "X-Goog-Upload-Header-Content-Type": mimeType,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ file: { displayName: "methodology" } }),
        }
    );

    if (!r.ok) {
        const text = await r.text();
        return res.status(r.status).json({ error: text.slice(0, 200) });
    }

    const uploadUrl = r.headers.get("x-goog-upload-url");
    if (!uploadUrl) return res.status(500).json({ error: "No upload URL returned" });

    return res.status(200).json({ uploadUrl });
}
