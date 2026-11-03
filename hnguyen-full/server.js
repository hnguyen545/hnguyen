require('dotenv').config();

// Bank details decoded from the QR image supplied by the site owner.
// Environment variables can override these defaults.
if (!process.env.BANK_ID || process.env.BANK_ID === 'VCB') process.env.BANK_ID = 'MB';
if (!process.env.BANK_ACCOUNT || process.env.BANK_ACCOUNT.startsWith('YOUR_')) process.env.BANK_ACCOUNT = '0559391160';
if (!process.env.BANK_OWNER || process.env.BANK_OWNER.startsWith('YOUR_')) process.env.BANK_OWNER = 'NGUYEN HUY HOANG';
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const PRIVATE = path.join(ROOT, 'private');
const DOWNLOADS = path.join(PRIVATE, 'downloads');
fs.mkdirSync(DOWNLOADS, { recursive: true });
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.startsWith('CHANGE_')) {
  console.warn('WARNING: Set a strong SESSION_SECRET in .env before production.');
}
if (!process.env.SEPAY_WEBHOOK_API_KEY || process.env.SEPAY_WEBHOOK_API_KEY.startsWith('CHANGE_')) {
  console.warn('WARNING: Set SEPAY_WEBHOOK_API_KEY and use the same API Key in SePay.');
}

const db = new Database(path.join(PRIVATE, 'hnguyen.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS products (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', price INTEGER NOT NULL,
 category TEXT NOT NULL DEFAULT 'template', label TEXT NOT NULL DEFAULT 'PROJECT', demo_url TEXT NOT NULL DEFAULT '',
 file_path TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, total INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', customer_name TEXT NOT NULL DEFAULT '', customer_email TEXT NOT NULL DEFAULT '',
 items_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, paid_at TEXT
);
CREATE TABLE IF NOT EXISTS transactions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, sepay_id TEXT NOT NULL UNIQUE, order_code TEXT NOT NULL,
 amount INTEGER NOT NULL, content TEXT NOT NULL DEFAULT '', raw_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS support (
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_code TEXT NOT NULL DEFAULT '', message TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, status TEXT NOT NULL DEFAULT 'new'
);
`);
const seed = [
 ['wave01','Neon Audio Spectrum','Project sóng nhạc neon xanh biển, thay audio và nội dung dễ dàng.',79000,'wave','WAVE / 01'],
 ['deep3d','Deep Ocean Visualizer','Không gian 3D xanh biển, ánh sáng và chuyển động mượt.',99000,'3d','DEEP / 3D'],
 ['aepack','Music Promo Bundle','Bộ intro, outro và visual quảng bá âm nhạc cho video.',149000,'template','AE / PACK']
];
const insertProduct = db.prepare('INSERT OR IGNORE INTO products (id,name,description,price,category,label) VALUES (?,?,?,?,?,?)');
seed.forEach(p => insertProduct.run(...p));

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(PUBLIC, { extensions: ['html'] }));

function sign(value) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'unsafe-development-secret').update(value).digest('hex');
}
function makeCookie(value) { return `${value}.${sign(value)}`; }
function isAdmin(req) {
  const raw = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('hng_admin='));
  if (!raw) return false;
  const token = decodeURIComponent(raw.slice('hng_admin='.length));
  const i = token.lastIndexOf('.'); if (i < 1) return false;
  const value = token.slice(0, i), mac = token.slice(i + 1);
  const expected = sign(value);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  const [user, expires] = value.split('|');
  return user === (process.env.ADMIN_USERNAME || 'admin') && Number(expires) > Date.now();
}
function adminOnly(req, res, next) { if (!isAdmin(req)) return res.status(401).json({ error: 'Vui lòng đăng nhập Admin.' }); next(); }
function publicProduct(p) { return { id:p.id,name:p.name,description:p.description,price:p.price,category:p.category,label:p.label,demo_url:p.demo_url,available:!!p.file_path }; }
function orderCode() { return 'HNG' + crypto.randomBytes(5).toString('hex').toUpperCase(); }
function bankReady() { return !!(process.env.BANK_ID && process.env.BANK_ACCOUNT && !process.env.BANK_ACCOUNT.startsWith('YOUR_')); }
function qrUrl(amount, code) {
  const q = new URL('https://vietqr.app/img');
  q.searchParams.set('acc', process.env.BANK_ACCOUNT || '');
  q.searchParams.set('bank', process.env.BANK_ID || '');
  q.searchParams.set('amount', String(amount));
  q.searchParams.set('des', code);
  q.searchParams.set('holder', process.env.BANK_OWNER || 'NGUYEN HUY HOANG');
  q.searchParams.set('template', 'compact');
  q.searchParams.set('fullacc', 'true');
  return q.toString();
}

app.get('/api/health', (req,res) => res.json({ ok:true, bankConfigured:bankReady() }));
app.get('/api/products', (req,res) => res.json(db.prepare('SELECT * FROM products WHERE active=1 ORDER BY created_at,id').all().map(publicProduct)));

app.post('/api/orders', (req,res) => {
  try {
    const items = req.body && req.body.items;
    if (!Array.isArray(items) || !items.length || items.length > 20) return res.status(400).json({error:'Giỏ hàng không hợp lệ.'});
    if (!bankReady()) return res.status(503).json({error:'Admin chưa cấu hình tài khoản ngân hàng trong file .env.'});
    const clean = []; let total = 0;
    for (const item of items) {
      const id = String(item.id || '').slice(0,80), qty = Math.max(1, Math.min(10, Math.floor(Number(item.qty) || 1)));
      const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(id);
      if (!p) return res.status(400).json({error:'Một sản phẩm trong giỏ không còn khả dụng.'});
      clean.push({id:p.id,name:p.name,price:p.price,qty,fileAvailable:!!p.file_path}); total += p.price * qty;
    }
    if (!Number.isSafeInteger(total) || total < 1000) return res.status(400).json({error:'Tổng tiền đơn hàng không hợp lệ.'});
    const code = orderCode();
    db.prepare('INSERT INTO orders (code,total,items_json) VALUES (?,?,?)').run(code,total,JSON.stringify(clean));
    res.json({ code,total,status:'pending',bankId:process.env.BANK_ID,bankAccount:process.env.BANK_ACCOUNT,bankOwner:process.env.BANK_OWNER || '',transferContent:code,qrUrl:qrUrl(total,code),expiresIn:900 });
  } catch(e) { console.error(e); res.status(500).json({error:'Không thể tạo đơn hàng lúc này.'}); }
});

app.get('/api/orders/:code', (req,res) => {
  const code = String(req.params.code || '').toUpperCase();
  const o = db.prepare('SELECT code,total,status,items_json,created_at,paid_at FROM orders WHERE code=?').get(code);
  if (!o) return res.status(404).json({error:'Không tìm thấy đơn hàng.'});
  const items = JSON.parse(o.items_json);
  let downloads = [];
  if (o.status === 'paid') {
    downloads = items.map(i => {
      const p = db.prepare('SELECT file_path FROM products WHERE id=?').get(i.id);
      return {name:i.name,qty:i.qty,url:p && p.file_path ? `/api/orders/${encodeURIComponent(code)}/download/${encodeURIComponent(i.id)}` : null};
    });
  }
  res.json({code:o.code,total:o.total,status:o.status,items,createdAt:o.created_at,paidAt:o.paid_at,downloads});
});
app.get('/api/orders/:code/download/:productId', (req,res) => {
  const code=String(req.params.code).toUpperCase(), id=String(req.params.productId);
  const o=db.prepare('SELECT status,items_json FROM orders WHERE code=?').get(code);
  if(!o || o.status!=='paid') return res.status(403).send('Đơn hàng chưa thanh toán.');
  const included=JSON.parse(o.items_json).some(x=>x.id===id);
  const p=included && db.prepare('SELECT name,file_path FROM products WHERE id=?').get(id);
  if(!p || !p.file_path) return res.status(404).send('File chưa được Admin tải lên.');
  const full=path.join(DOWNLOADS,path.basename(p.file_path));
  if(!fs.existsSync(full)) return res.status(404).send('Không tìm thấy file. Vui lòng liên hệ Admin.');
  res.download(full, path.basename(full));
});

app.post('/api/support', (req,res) => {
  const code=String(req.body.orderCode||'').trim().toUpperCase().slice(0,40);
  const message=String(req.body.message||'').trim().slice(0,2000);
  if(message.length<5) return res.status(400).json({error:'Vui lòng nhập nội dung hỗ trợ (ít nhất 5 ký tự).'});
  const result=db.prepare('INSERT INTO support (order_code,message) VALUES (?,?)').run(code,message);
  res.json({success:true,id:result.lastInsertRowid});
});

// SePay sends an incoming-transfer webhook. Configure API Key authentication in SePay.
app.post('/api/sepay/webhook', (req,res) => {
  const configured=process.env.SEPAY_WEBHOOK_API_KEY;
  const auth=String(req.get('authorization')||'');
  if(!configured || configured.startsWith('CHANGE_') || auth !== `Apikey ${configured}`) return res.status(401).json({success:false,message:'Unauthorized'});
  const t=req.body||{};
  if(String(t.transferType||'').toLowerCase()!=='in') return res.json({success:true,ignored:'not incoming'});
  const transferId=String(t.id||'');
  if(!transferId) return res.status(400).json({success:false,message:'Missing transaction id'});
  if(db.prepare('SELECT 1 FROM transactions WHERE sepay_id=?').get(transferId)) return res.json({success:true,duplicate:true});
  const codeField=String(t.code||'').toUpperCase();
  const content=String(t.content||t.description||'').toUpperCase();
  const match=codeField.match(/HNG[A-F0-9]{10}/) || content.match(/HNG[A-F0-9]{10}/);
  if(!match) return res.json({success:true,ignored:'payment code not found'});
  const code=match[0];
  const order=db.prepare('SELECT * FROM orders WHERE code=?').get(code);
  if(!order || order.status==='paid') return res.json({success:true,ignored:'order missing or already paid'});
  const amount=Math.floor(Number(t.transferAmount)||0);
  if(amount!==order.total) return res.json({success:true,ignored:'amount mismatch'});
  const expectedAccount=String(process.env.BANK_ACCOUNT||'').replace(/\s/g,'');
  const incomingAccount=String(t.accountNumber||'').replace(/\s/g,'');
  if(expectedAccount && incomingAccount && expectedAccount!==incomingAccount) return res.json({success:true,ignored:'bank account mismatch'});
  const save=db.transaction(()=>{
    db.prepare('INSERT INTO transactions (sepay_id,order_code,amount,content,raw_json) VALUES (?,?,?,?,?)').run(transferId,code,amount,String(t.content||''),JSON.stringify(t));
    db.prepare("UPDATE orders SET status='paid',paid_at=CURRENT_TIMESTAMP WHERE code=? AND status='pending'").run(code);
  });
  try { save(); return res.json({success:true,orderCode:code}); }
  catch(e) { console.error('SePay webhook error',e); return res.status(500).json({success:false}); }
});

const storage=multer.diskStorage({
 destination:(req,file,cb)=>cb(null,DOWNLOADS),
 filename:(req,file,cb)=>{const ext=path.extname(file.originalname).slice(0,12).replace(/[^.a-zA-Z0-9]/g,'');cb(null,crypto.randomBytes(12).toString('hex')+ext);}
});
const upload=multer({storage,limits:{fileSize:500*1024*1024},fileFilter:(req,file,cb)=>{
 const ok=/\.(zip|rar|7z|aep|mp4|pdf)$/i.test(file.originalname); cb(ok?null:new Error('Chỉ nhận file ZIP, RAR, 7Z, AEP, MP4 hoặc PDF.'),ok);
}});
app.post('/api/admin/login', rateLimit({windowMs:15*60_000,limit:10}), (req,res)=>{
 const user=String(req.body.username||''), pass=String(req.body.password||'');
 if(user!==(process.env.ADMIN_USERNAME||'admin') || !process.env.ADMIN_PASSWORD || pass!==process.env.ADMIN_PASSWORD) return res.status(401).json({error:'Sai tài khoản hoặc mật khẩu.'});
 const value=`${user}|${Date.now()+8*60*60*1000}`;
 res.cookie('hng_admin',makeCookie(value),{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production',maxAge:8*60*60*1000,path:'/'});
 res.json({success:true});
});
app.post('/api/admin/logout', (req,res)=>{res.clearCookie('hng_admin',{path:'/'});res.json({success:true});});
app.get('/api/admin/me',adminOnly,(req,res)=>res.json({success:true}));
app.get('/api/admin/dashboard',adminOnly,(req,res)=>{
 const orders=db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 200').all().map(o=>({...o,items:JSON.parse(o.items_json)}));
 const supports=db.prepare('SELECT * FROM support ORDER BY id DESC LIMIT 200').all();
 const products=db.prepare('SELECT * FROM products ORDER BY created_at DESC').all();
 res.json({orders,supports,products,stats:{orders:db.prepare('SELECT count(*) n FROM orders').get().n,paid:db.prepare("SELECT count(*) n FROM orders WHERE status='paid'").get().n,revenue:db.prepare("SELECT coalesce(sum(total),0) n FROM orders WHERE status='paid'").get().n,pending:db.prepare("SELECT count(*) n FROM orders WHERE status='pending'").get().n}});
});
app.post('/api/admin/products',adminOnly,upload.single('file'),(req,res)=>{
 const b=req.body||{}; const id=String(b.id||'').trim().toLowerCase().replace(/[^a-z0-9_-]/g,'').slice(0,80);
 const name=String(b.name||'').trim().slice(0,120); const price=Math.floor(Number(b.price));
 if(!id||!name||!Number.isSafeInteger(price)||price<1000) return res.status(400).json({error:'ID, tên sản phẩm và giá từ 1.000đ là bắt buộc.'});
 const old=db.prepare('SELECT * FROM products WHERE id=?').get(id);
 const filePath=req.file?req.file.filename:(old?old.file_path:'');
 db.prepare(`INSERT INTO products (id,name,description,price,category,label,demo_url,file_path,active) VALUES (?,?,?,?,?,?,?,?,1)
 ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,price=excluded.price,category=excluded.category,label=excluded.label,demo_url=excluded.demo_url,file_path=CASE WHEN excluded.file_path='' THEN products.file_path ELSE excluded.file_path END,active=1`)
 .run(id,name,String(b.description||''),price,String(b.category||'template'),String(b.label||'PROJECT'),String(b.demo_url||''),filePath);
 res.json({success:true});
});
app.post('/api/admin/products/:id/toggle',adminOnly,(req,res)=>{db.prepare('UPDATE products SET active=1-active WHERE id=?').run(req.params.id);res.json({success:true});});
app.post('/api/admin/support/:id/close',adminOnly,(req,res)=>{db.prepare("UPDATE support SET status='closed' WHERE id=?").run(Number(req.params.id));res.json({success:true});});
app.use((err,req,res,next)=>{console.error(err);res.status(400).json({error:err.message||'Request không hợp lệ.'});});
app.get('*',(req,res)=>res.sendFile(path.join(PUBLIC,'index.html')));
app.listen(PORT,()=>console.log(`HNGUYEN running on http://localhost:${PORT}`));
