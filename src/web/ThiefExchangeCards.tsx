import { useEffect, useState } from 'react';
import type { Role } from '../domain/rules.ts';
import { roleNames } from './types.ts';

function Card({ role, back }: { role: Role; back?: boolean }) {
  const [failed,setFailed]=useState(false);
  return <div className="exchange-card">{!failed?<img src={back?'/images/roles/card-back.png':`/images/roles/${role}.png`} alt={back?'裏向きのカード':`${roleNames[role]}の役職カード`} onError={()=>setFailed(true)} width="1024" height="1536"/>:<span>{back?'☾':roleNames[role]}</span>}</div>;
}
export default function ThiefExchangeCards({ thiefName, targetName, stolenRole, animate=false, privateView=false, onComplete }: { thiefName:string;targetName:string;stolenRole:Role;animate?:boolean;privateView?:boolean;onComplete?:()=>void }) {
  const [done,setDone]=useState(!animate);
  useEffect(()=>{
    if(!animate){setDone(true);return;}
    const media=matchMedia('(prefers-reduced-motion: reduce)');
    const finish=()=>{setDone(true);onComplete?.();};
    if(media.matches){finish();return;}
    const timer=setTimeout(finish,2000);const changed=()=>{if(media.matches)finish();};media.addEventListener('change',changed);
    return()=>{clearTimeout(timer);media.removeEventListener('change',changed);};
  },[animate,onComplete]);
  return <div className={`thief-exchange ${animate&&!done?'exchange-moving':'exchange-complete'} ${privateView?'exchange-private':''}`}>
    <div className="exchange-pair">{animate&&!done&&<div className="exchange-flying-card" aria-hidden="true"><Card role={stolenRole} back={privateView}/></div>}<div className="exchange-person"><strong>{thiefName}</strong><div className="exchange-slot"><div className="exchange-before"><Card role="thief"/></div><div className="exchange-after"><Card role={stolenRole}/></div></div><span>{done?`${privateView?'':roleNames.thief+' → '}${roleNames[stolenRole]}`:'怪盗'}</span></div>
    <span className="exchange-arrow" aria-hidden="true">←</span><div className="exchange-person"><strong>{targetName}</strong><div className="exchange-slot"><div className="exchange-before"><Card role={stolenRole} back={privateView}/></div><div className="exchange-after"><Card role="villager" back={privateView}/></div></div><span>{privateView?'役職を奪った相手':done?`${roleNames[stolenRole]} → 村人`:roleNames[stolenRole]}</span></div></div>
    {privateView&&animate&&!done&&<button className="text-button" onClick={()=>{setDone(true);onComplete?.();}}>演出をスキップ</button>}
  </div>;
}
