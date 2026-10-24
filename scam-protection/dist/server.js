import express from "express";
const app = express();
const PORT = Number(process.env.PORT) || 3000;
app.get("/health", (_req, res) => {
    res.status(200).json({
        status: "ok",
        service: "scam-protection-api"
    });
});
app.listen(PORT, () => {
    console.log(`Scam protection backend running on port ${PORT}`);
});
