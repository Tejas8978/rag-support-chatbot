require('dotenv').config();
const mongoose = require('mongoose');
const { Doc } = require('./models');
const rag = require('./rag');

const docs = [
  { title: 'Password reset (English)', lang: 'en', text: "To reset your password, open the login page and click 'Forgot password?'. Enter your registered email and we will send a reset link that is valid for 30 minutes." },
  { title: 'Password reset (Telugu)', lang: 'te', text: "మీ పాస్‌వర్డ్‌ను రీసెట్ చేయడానికి, లాగిన్ పేజీలో 'పాస్‌వర్డ్ మర్చిపోయారా?' క్లిక్ చేయండి. మీ రిజిస్టర్డ్ ఈమెయిల్ ఇవ్వండి, 30 నిమిషాల పాటు చెల్లుబాటు అయ్యే లింక్ పంపబడుతుంది." },
  { title: 'Refunds (Hindi)', lang: 'hi', text: 'रिफंड के लिए ऑर्डर मिलने के 7 दिनों के भीतर आवेदन करें। स्वीकृत होने पर राशि 5 से 7 कार्य दिवसों में मूल भुगतान माध्यम में वापस कर दी जाती है।' }
];

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/rag_support');
  for (const d of docs) { const doc = await Doc.create(d); await rag.indexDoc(doc); console.log('Indexed', d.title); }
  process.exit(0);
})();
