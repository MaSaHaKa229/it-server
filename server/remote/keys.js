// Ключ сервера для подписи пропусков на подключение (ECDSA P-256).
// Создаётся при первом запуске; закрытый ключ хранится в базе зашифрованным APP_SECRET_KEY.
// Открытый ключ устанавливается на агенты — им они проверяют пропуска (protocol/PROTOCOL.md, раздел 5).
const crypto = require('crypto');
const { encrypt, decrypt } = require('../inventory/crypto');

let cached = null;

async function ensureKey(db) {
  if (cached) return cached;
  const { rows } = await db.query(`SELECT value FROM remote.settings WHERE key = 'signing_key'`);
  let v = rows[0] && rows[0].value;
  if (!v) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    v = {
      private_enc: encrypt(privateKey.export({ type: 'pkcs8', format: 'pem' })),
      public_pem: publicKey.export({ type: 'spki', format: 'pem' }),
      created_at: new Date().toISOString(),
    };
    // Если два процесса стартуют одновременно — побеждает первый
    await db.query(`INSERT INTO remote.settings (key, value) VALUES ('signing_key', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(v)]);
    v = (await db.query(`SELECT value FROM remote.settings WHERE key = 'signing_key'`)).rows[0].value;
  }
  let privatePem;
  try {
    privatePem = decrypt(v.private_enc);
  } catch {
    throw new Error('Не удалось расшифровать ключ удалённого доступа: изменился APP_SECRET_KEY в .env. Верните прежнее значение.');
  }
  const der = crypto.createPublicKey(v.public_pem).export({ type: 'spki', format: 'der' });
  cached = {
    privateKey: crypto.createPrivateKey(privatePem),
    publicPem: v.public_pem,
    // Отпечаток открытого ключа — для сверки при установке агентов
    fingerprint: crypto.createHash('sha256').update(der).digest('hex'),
  };
  return cached;
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Пропуск для агента: v1.<json>.<подпись> */
function signToken(key, payload) {
  const head = 'v1.' + b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = crypto.sign('sha256', Buffer.from(head, 'ascii'), { key: key.privateKey, dsaEncoding: 'der' });
  return head + '.' + b64url(sig);
}

const randomSecret = (bytes = 32) => b64url(crypto.randomBytes(bytes));
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

module.exports = { ensureKey, signToken, randomSecret, sha256 };
