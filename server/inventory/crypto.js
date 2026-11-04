// Шифрование паролей устройств (AES-256-GCM).
// Ключ берётся из APP_SECRET_KEY. Если ключ сменить — старые пароли расшифровать не получится.
const crypto = require('crypto');

function getKey() {
  const raw = process.env.APP_SECRET_KEY;
  if (!raw) {
    throw new Error('Не задан APP_SECRET_KEY в .env — он нужен для шифрования паролей устройств');
  }
  // Любую строку приводим к 32 байтам
  return crypto.createHash('sha256').update(raw).digest();
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(b64) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
