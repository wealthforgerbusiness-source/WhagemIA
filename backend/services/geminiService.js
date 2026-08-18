const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Modèle le moins cher en tokens : gemini-2.0-flash-lite ou gemini-1.5-flash-8b
const MODEL_NAME = 'gemini-2.0-flash-lite';

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
  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: buildSystemPrompt(businessPrompt),
  });

  const result = await model.generateContent(userMessage);
  const response = result.response;
  const text = response.text();

  // Récupération de l'usage réel de tokens renvoyé par Gemini
  const usage = response.usageMetadata || {};
  const tokensIn = usage.promptTokenCount || 0;
  const tokensOut = usage.candidatesTokenCount || 0;

  return { text, tokensIn, tokensOut };
}

module.exports = { generateReply };
