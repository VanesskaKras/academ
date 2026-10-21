import { requireAuth, applyCors } from "./_auth.js";

export const config = {
    maxDuration: 300,
    api: {
        bodyParser: {
            sizeLimit: "10mb",
        },
    },
};

export default async function handler(req, res) {
    applyCors(req, res);
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).end();
    if (!(await requireAuth(req, res))) return;

    try {
        const body = req.body;

        if (body.max_tokens && body.max_tokens > 64000) {
            body.max_tokens = 64000;
        }

        // Streaming mode — pipe SSE directly to client so Vercel doesn't timeout
        if (body.stream) {
            const response = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": process.env.ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01",
                },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                const data = await response.json();
                console.error("Anthropic streaming error:", response.status, JSON.stringify(data));
                return res.status(response.status).json(data);
            }

            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    res.write(decoder.decode(value, { stream: true }));
                }
            } finally {
                res.end();
            }
            return;
        }

        // Non-streaming (used for short JSON tasks like plan generation)
        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": process.env.ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify(body),
        });

        const data = await response.json();

        if (!response.ok) {
            console.error("Anthropic API error:", response.status, JSON.stringify(data));
            return res.status(response.status).json(data);
        }

        res.status(200).json(data);
    } catch (e) {
        console.error("Handler error:", e.message);
        res.status(500).json({ error: e.message });
    }
}
