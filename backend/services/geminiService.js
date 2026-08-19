const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// IMPORTANT : gemini-2.0-flash-lite a été DÉFINITIVEMENT ARRÊTÉ par Google le 1er juin 2026.
// C'est la cause du bug "l'IA ne répond pas" : chaque appel renvoyait une erreur 404,
// silencieusement avalée par le try/catch de baileysService.js.
// gemini-3.1-flash-lite est le modèle de remplacement recommandé par Google (le moins cher,
// pas de date d'arrêt annoncée à ce jour). Si Google l'arrête un jour, ce sera annoncé ici :
// https://ai.google.dev/gemini-api/docs/deprecations
const MODEL_NAME = 'gemini-3.1-flash-lite';

function buildSystemPrompt(businessPrompt) {
  return `Tu es un assistant IA WhatsApp pour cette entreprise : ${businessPrompt}

RÈGLES STRICTES :
- Réponds UNIQUEMENT aux questions liées à cette entreprise.
- Sois court et direct, va droit au but.
- N'utilise JAMAIS de formules de politesse type "Bonjour", "Bonsoir", "Comment puis-je vous aider".
- Ne fais AUCUN blabla, pas d'introduction, pas de conclusion inutile.
- Réponds directement à la question posée, comme un employé efficace par SMS.
- Si la question sort du cadre de l'entreprise, dis simplement que tu ne peux pas aider sur ce sujet.`;
}

async function generateReply(businessPrompt, userMessage) {
  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents: userMessage,
    config: {
      systemInstruction: buildSystemPrompt(businessPrompt),
    },
  });

  const text = response.text;

  // Récupération de l'usage réel de tokens renvoyé par Gemini
  const usage = response.usageMetadata || {};
  const tokensIn = usage.promptTokenCount || 0;
  const tokensOut = usage.candidatesTokenCount || 0;

  return { text, tokensIn, tokensOut };
}

module.exports = { generateReply };
