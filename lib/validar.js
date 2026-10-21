const PESOS = [5,4,3,2,7,6,5,4,3,2];

export function dv(b){let s=0;for(let i=0;i<10;i++)s+=Number(b[i])*PESOS[i];const v=11-(s%11);return v===11?0:v;}

export function normalizarDni(x){
  const s=String(x==null?'':x).replace(/\D/g,'');
  if(!s) return null;
  if(s.length===11) return s.slice(2,10);
  if(s.length>8) return null;
  return s.padStart(8,'0');
}

export function cuilDeDni(sexo,dni){
  const d=normalizarDni(dni); if(!d) return null;
  let p=sexo==='F'?27:20;
  let v=dv(String(p)+d);
  if(v===10){p=23;v=dv(String(p)+d);}
  return p+'-'+d+'-'+v;
}

export function cuitValido(c){
  const s=String(c).replace(/-/g,'');
  if(!/^\d{11}$/.test(s))return false;
  let x=0;for(let i=0;i<10;i++)x+=Number(s[i])*PESOS[i];
  let r=11-(x%11);if(r===11)r=0;if(r===10)r=9;
  return r===Number(s[10]);
}

const PART=new Set(['DE','DEL','LA','LAS','LOS','VAN','VON','DER','DI','DA','DOS','SAN','SANTA','MAC','MC','Y']);
export function separarNombre(d){
  const l=String(d).replace(/\s+/g,' ').trim();
  const suc=/^SUCESION DE /i.test(l);
  const c=suc?l.replace(/^SUCESION DE /i,''):l;
  const t=c.split(' ').filter(Boolean);
  if(!t.length)return{apellido:'',nombre:'',sucesion:suc};
  let k=1;
  if(PART.has(t[0].toUpperCase())){k=1;while(k<t.length&&PART.has(t[k].toUpperCase()))k++;k++;}
  return{apellido:t.slice(0,k).join(' '),nombre:t.slice(k).join(' '),sucesion:suc};
}
