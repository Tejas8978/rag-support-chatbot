const crypto = require('crypto');
const { User, Session } = require('./models');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, key] = stored.split(':');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(key, 'hex'));
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await Session.create({ token, userId });
  return token;
}

// Middleware to extract authenticated user from Authorization header
async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }
  const token = header.slice(7).trim();
  if (!token) {
    req.user = null;
    return next();
  }
  try {
    const session = await Session.findOne({ token }).populate('userId');
    if (session && session.userId) {
      req.user = {
        id: session.userId._id,
        name: session.userId.name,
        email: session.userId.email,
        role: session.userId.role
      };
      req.sessionToken = token;
    } else {
      req.user = null;
    }
  } catch (err) {
    req.user = null;
  }
  next();
}

// Ensure default demo user exists in MongoDB
async function ensureDefaultUser() {
  try {
    const count = await User.countDocuments();
    if (count === 0) {
      const demoPass = hashPassword('demo1234');
      await User.create({
        name: 'Demo Support Lead',
        email: 'demo@example.com',
        password: demoPass,
        role: 'admin'
      });
      console.log('Created default account: demo@example.com / demo1234');
    }
  } catch (e) {
    console.warn('Could not seed default user:', e.message);
  }
}

module.exports = { hashPassword, verifyPassword, createSession, authMiddleware, ensureDefaultUser };
