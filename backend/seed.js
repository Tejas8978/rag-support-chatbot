require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['1.1.1.1', '1.0.0.1', '8.8.8.8']);
const mongoose = require('mongoose');
const { Doc, User } = require('./models');
const { hashPassword } = require('./auth');
const rag = require('./rag');

const docs = [
  { title: 'Password reset (English)', lang: 'en', text: "To reset your password, open the login page and click 'Forgot password?'. Enter your registered email and we will send a reset link that is valid for 30 minutes." },
  { title: 'Password reset (Telugu)', lang: 'te', text: "మీ పాస్‌వర్డ్‌ను రీసెట్ చేయడానికి, లాగిన్ పేజీలో 'పాస్‌వర్డ్ మర్చిపోయారా?' క్లిక్ చేయండి. మీ రిజిస్టర్డ్ ఈమెయిల్ ఇవ్వండి, 30 నిమిషాల పాటు చెల్లుబాటు అయ్యే లింక్ పంపబడుతుంది." },
  { title: 'Refunds (Hindi)', lang: 'hi', text: 'रिफंड के लिए ऑर्डर मिलने के 7 दिनों के भीतर आवेदन करें। स्वीकृत होने पर राशि 5 से 7 कार्य दिवसों में मूल भुगतान माध्यम में वापस कर दी जाती है।' }
];

(async () => {
  console.log('Connecting to MongoDB Atlas...');
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/rag_support', {
    family: 4,
    serverSelectionTimeoutMS: 15000,
  });

  // Seed default demo user if not present
  const existingUser = await User.findOne({ email: 'demo@example.com' });
  if (!existingUser) {
    await User.create({
      name: 'Demo Support Lead',
      email: 'demo@example.com',
      password: hashPassword('demo1234'),
      role: 'admin'
    });
    console.log('Seeded demo user: demo@example.com / demo1234');
  }

  for (const d of docs) {
    const existing = await Doc.findOne({ title: d.title });
    if (!existing) {
      const doc = await Doc.create(d);
      await rag.indexDoc(doc);
      console.log('Indexed:', d.title);
    }
  }

  console.log('Seed completed successfully!');
  process.exit(0);
})();
