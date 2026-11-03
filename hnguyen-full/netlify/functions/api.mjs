import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false,autoRefreshToken:false}});
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'hnguyen-private';
const headers = {'content-type':'application/json; charset=utf-8','cache-control':'no-store'};
const json = (statusCode, body, extra={}) => ({statusCode,headers:{...headers,...extra},body:JSON.stringify(body)});
const parse = e => {try{return JSON.parse(e.body||'{}')}catch{return {}}};
const pathOf = e => (e.rawPath || e.path || '/').replace(/^\/.netlify\/functions\/api/,'').replace(/^\/api(?=\/|$)/,'') || '/' ;
const methodOf = e => e.requestContext?.http?.method || e.httpMethod || 'GET';
const sign = value => crypto.createHmac('sha256',process.env.SESSION_SECRET||'').update(value).digest('hex');
function cookie(event){const raw=event.headers?.cookie||event.headers?.Cookie||'';const pair=raw.split(';').map(x=>x.trim()).find(x=>x.startsWith('hng_admin='));if(!pair)return false;try{const token=decodeURIComponent(pair.slice(10));const i=token.lastIndexOf('.');if(i<1)return false;const v=token.slice(0,i),mac=token.slice(i+1),expected=sign(v);if(!process.env.SESSION_SECRET||mac.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(mac),Buffer.from(expected)))return false;const [user,exp]=v.split('|');return user===(process.env.ADMIN_USERNAME||'admin')&&Number(exp)>Date.now()}catch{return false}}
const admin=(e)=>cookie(e);
const orderCode=()=>`HNG${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
const bankReady=()=>!!(process.env.BANK_ID&&process.env.BANK_ACCOUNT&&!process.env.BANK_ACCOUNT.startsWith('YOUR_'));
function qrUrl(amount,code){const q=new URL('https://vietqr.app/img');q.searchParams.set('acc',process.env.BANK_ACCOUNT||'');q.searchParams.set('bank',process.env.BANK_ID||'');q.searchParams.set('amount',String(amount));q.searchParams.set('des',code);q.searchParams.set('holder',process.env.BANK_OWNER||'');q.searchParams.set('template','compact');q.searchParams.set('fullacc','true');return q.toString()}
async function one(table,query){const {data,error}=await supabase.from(table).select('*').match(query).maybeSingle();if(error)throw error;return data}
async function rows(table,opts={}){let q=supabase.from(table).select('*');if(opts.order)q=q.order(opts.order,{ascending:opts.ascending??false});if(opts.limit)q=q.limit(opts.limit);const {data,error}=await q;if(error)throw error;return data||[]}
async function getOrder(code){return one('orders',{code})}
export const handler = async (event)=>{
 const path=pathOf(event), method=methodOf(event), body=parse(event);
 try {
  if(path==='/health'&&method==='GET')return json(200,{ok:true,bankConfigured:bankReady(),storageConfigured:!!process.env.SUPABASE_URL});
  if(path==='/products'&&method==='GET'){const {data,error}=await supabase.from('products').select('id,name,description,price,category,label,demo_url,file_path,active').eq('active',true).order('created_at');if(error)throw error;return json(200,(data||[]).map(p=>({...p,available:!!p.file_path})));}
  if(path==='/orders'&&method==='POST'){
   const items=body.items;if(!Array.isArray(items)||!items.length||items.length>20)return json(400,{error:'Giỏ hàng không hợp lệ.'});if(!bankReady())return json(503,{error:'Admin chưa cấu hình tài khoản ngân hàng.'});
   const clean=[];let total=0;for(const item of items){const id=String(item.id||'').slice(0,80),qty=Math.max(1,Math.min(10,Math.floor(Number(item.qty)||1)));const p=await one('products',{id,active:true});if(!p)return json(400,{error:'Một sản phẩm trong giỏ không còn khả dụng.'});clean.push({id:p.id,name:p.name,price:p.price,qty,fileAvailable:!!p.file_path});total+=p.price*qty;}
   if(!Number.isSafeInteger(total)||total<1000)return json(400,{error:'Tổng tiền đơn hàng không hợp lệ.'});const code=orderCode();const {error}=await supabase.from('orders').insert({code,total,status:'pending',customer_name:'',customer_email:'',items_json:clean});if(error)throw error;
   return json(200,{code,total,status:'pending',bankId:process.env.BANK_ID,bankAccount:process.env.BANK_ACCOUNT,bankOwner:process.env.BANK_OWNER||'',transferContent:code,qrUrl:qrUrl(total,code),expiresIn:900});
  }
  const orderMatch=path.match(/^\/orders\/([A-Za-z0-9_-]+)$/);
  if(orderMatch&&method==='GET'){const code=decodeURIComponent(orderMatch[1]).toUpperCase(),o=await getOrder(code);if(!o)return json(404,{error:'Không tìm thấy đơn hàng.'});const items=Array.isArray(o.items_json)?o.items_json:JSON.parse(o.items_json||'[]');let downloads=[];if(o.status==='paid'){for(const i of items){const p=await one('products',{id:i.id});let url=null;if(p?.file_path){const {data,error}=await supabase.storage.from(BUCKET).createSignedUrl(p.file_path,60*60);if(!error)url=data.signedUrl;}downloads.push({name:i.name,qty:i.qty,url});}}return json(200,{code:o.code,total:o.total,status:o.status,items,createdAt:o.created_at,paidAt:o.paid_at,downloads});}
  const downloadMatch=path.match(/^\/orders\/([^/]+)\/download\/([^/]+)$/);
  if(downloadMatch&&method==='GET'){const code=decodeURIComponent(downloadMatch[1]).toUpperCase(),id=decodeURIComponent(downloadMatch[2]),o=await getOrder(code);if(!o||o.status!=='paid')return json(403,{error:'Đơn hàng chưa thanh toán.'});const items=Array.isArray(o.items_json)?o.items_json:JSON.parse(o.items_json||'[]');if(!items.some(x=>x.id===id))return json(403,{error:'Sản phẩm không thuộc đơn hàng.'});const p=await one('products',{id});if(!p?.file_path)return json(404,{error:'File chưa được Admin tải lên.'});const {data,error}=await supabase.storage.from(BUCKET).createSignedUrl(p.file_path,60*10,{download:true});if(error)throw error;return {statusCode:302,headers:{location:data.signedUrl,'cache-control':'no-store'},body:''};}
  if(path==='/support'&&method==='POST'){const code=String(body.orderCode||'').trim().toUpperCase().slice(0,40),message=String(body.message||'').trim().slice(0,2000);if(message.length<5)return json(400,{error:'Vui lòng nhập nội dung hỗ trợ (ít nhất 5 ký tự).'});const {data,error}=await supabase.from('support').insert({order_code:code,message,status:'new'}).select('id').single();if(error)throw error;return json(200,{success:true,id:data.id});}
  if(path==='/sepay/webhook'&&method==='POST'){
   const configured=process.env.SEPAY_WEBHOOK_API_KEY,auth=event.headers?.authorization||event.headers?.Authorization||'';if(!configured||configured.startsWith('CHANGE_')||auth!==`Apikey ${configured}`)return json(401,{success:false,message:'Unauthorized'});
   const t=body;if(String(t.transferType||'').toLowerCase()!=='in')return json(200,{success:true,ignored:'not incoming'});const transferId=String(t.id||'');if(!transferId)return json(400,{success:false,message:'Missing transaction id'});
   const codeField=String(t.code||'').toUpperCase(),content=String(t.content||t.description||'').toUpperCase(),match=codeField.match(/HNG[A-F0-9]{10}/)||content.match(/HNG[A-F0-9]{10}/);if(!match)return json(200,{success:true,ignored:'payment code not found'});
   const {data,error}=await supabase.rpc('process_sepay_payment',{p_sepay_id:transferId,p_order_code:match[0],p_amount:Math.floor(Number(t.transferAmount)||0),p_content:String(t.content||''),p_raw:t,p_account_number:String(t.accountNumber||''),p_expected_account:String(process.env.BANK_ACCOUNT||'').replace(/\s/g,'')});if(error)throw error;return json(200,data||{success:true});
  }
  if(path==='/admin/login'&&method==='POST'){
   const user=String(body.username||''),pass=String(body.password||'');if(user!==(process.env.ADMIN_USERNAME||'admin')||!process.env.ADMIN_PASSWORD||pass!==process.env.ADMIN_PASSWORD)return json(401,{error:'Sai tài khoản hoặc mật khẩu.'});const value=`${user}|${Date.now()+8*60*60*1000}`,token=`${value}.${sign(value)}`;return json(200,{success:true},{'set-cookie':`hng_admin=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`});
  }
  if(path==='/admin/logout'&&method==='POST')return json(200,{success:true},{'set-cookie':'hng_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'});
  if(path==='/admin/me'&&method==='GET')return admin(event)?json(200,{success:true}):json(401,{error:'Vui lòng đăng nhập Admin.'});
  if(path.startsWith('/admin/')&&!admin(event))return json(401,{error:'Vui lòng đăng nhập Admin.'});
  if(path==='/admin/dashboard'&&method==='GET'){
   const [orders,supports,products]=await Promise.all([rows('orders',{order:'created_at',limit:200}),rows('support',{order:'created_at',limit:200}),rows('products',{order:'created_at'})]);const normalized=orders.map(o=>({...o,items:Array.isArray(o.items_json)?o.items_json:JSON.parse(o.items_json||'[]')}));const paid=orders.filter(o=>o.status==='paid');return json(200,{orders:normalized,supports,products,stats:{orders:orders.length,paid:paid.length,revenue:paid.reduce((s,o)=>s+Number(o.total||0),0),pending:orders.filter(o=>o.status==='pending').length}});
  }
  if(path==='/admin/upload-url'&&method==='POST'){
   const name=String(body.filename||'file.bin'),ext=(name.match(/\.[^.]+$/)||[''])[0].toLowerCase();if(!/^\.(zip|rar|7z|aep|mp4|pdf)$/.test(ext))return json(400,{error:'Định dạng file không được hỗ trợ.'});const objectPath=`products/${crypto.randomUUID()}${ext}`;const {data,error}=await supabase.storage.from(BUCKET).createSignedUploadUrl(objectPath,{upsert:false});if(error)throw error;return json(200,{path:objectPath,token:data.token,signedUrl:data.signedUrl});
  }
  if(path==='/admin/products'&&method==='POST'){
   const id=String(body.id||'').trim().toLowerCase().replace(/[^a-z0-9_-]/g,'').slice(0,80),name=String(body.name||'').trim().slice(0,120),price=Math.floor(Number(body.price));if(!id||!name||!Number.isSafeInteger(price)||price<1000)return json(400,{error:'ID, tên sản phẩm và giá từ 1.000đ là bắt buộc.'});const payload={id,name,description:String(body.description||''),price,category:String(body.category||'template'),label:String(body.label||'PROJECT'),demo_url:String(body.demo_url||''),active:true};if(body.file_path)payload.file_path=String(body.file_path);const {error}=await supabase.from('products').upsert(payload,{onConflict:'id'});if(error)throw error;return json(200,{success:true});
  }
  const toggle=path.match(/^\/admin\/products\/([^/]+)\/toggle$/);if(toggle&&method==='POST'){const p=await one('products',{id:decodeURIComponent(toggle[1])});if(!p)return json(404,{error:'Không tìm thấy sản phẩm.'});const {error}=await supabase.from('products').update({active:!p.active}).eq('id',p.id);if(error)throw error;return json(200,{success:true});}
  const close=path.match(/^\/admin\/support\/([^/]+)\/close$/);if(close&&method==='POST'){const {error}=await supabase.from('support').update({status:'closed'}).eq('id',Number(close[1]));if(error)throw error;return json(200,{success:true});}
  return json(404,{error:'Không tìm thấy API.'});
 }catch(err){console.error('HNGUYEN API error:',err);return json(500,{error:'Máy chủ gặp lỗi. Vui lòng thử lại.'});}
};
