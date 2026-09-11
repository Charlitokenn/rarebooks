import{InternalThemeProvider as Q}from"./index-DafoNVVP.js";import{h as ee}from"./shared-D8dmX9-H.js";import{r as n,e as te,j as a,u as ne,b as _,F as re}from"./index--zwhJJ6x.js";import{u as ie}from"./EnvironmentContext-B9dLVnSe.js";import{e as b}from"./index-CpdMWlkh.js";import{i as oe}from"./inert-BvL3cDXs.js";import"./AppearanceContext-D3b6eaJF.js";import"./OptionsContext-B8YMK5tr.js";import"./utils-V2FbmPWk-CO7FM5J0.js";import"./underscore-PzdM3hke.js";import"./makeLocalizable-D4zc-mxB.js";import"./localizationKeys-L95TEc06.js";import"./makeCustomizable-Bzmt06QU.js";import"./url-BW4YVlrT.js";const q="clerk-keyless-prompt-corner",A="1.25rem",W=20,se=5,ce=10,j=.999,ae="transform 350ms cubic-bezier(0.34, 1.2, 0.64, 1)",B="translate3d(0px, 0px, 0)",v={x:0,y:0};function le(e,r){let s="bottom-right",c=1/0;for(const[l,g]of Object.entries(r)){const C=e.x-g.x,R=e.y-g.y,E=Math.sqrt(C*C+R*R);E<c&&(c=E,s=l)}return s}function ue(e){switch(e){case"top-left":return{top:A,left:A};case"top-right":return{top:A,right:A};case"bottom-left":return{bottom:A,left:A};case"bottom-right":return{bottom:A,right:A}}}const de=["top-left","top-right","bottom-left","bottom-right"];function G(e){if(!(typeof window>"u"))try{localStorage.setItem(q,e)}catch{}}function Z(e){return e/1e3*j/(1-j)}function pe(e){if(e.length<2)return v;const r=e[0],s=e[e.length-1],c=s.timestamp-r.timestamp;return c===0?v:{x:(s.position.x-r.position.x)/c*1e3,y:(s.position.y-r.position.y)/c*1e3}}function fe(){const[e,r]=n.useState("bottom-right"),[s,c]=n.useState(!1),[l,g]=n.useState(!1),[C,R]=n.useState(!1),E=n.useRef(null);n.useEffect(()=>{if(typeof window>"u"){R(!0);return}try{const t=localStorage.getItem(q);t&&de.includes(t)&&r(t)}catch{}finally{R(!0)}},[]);const m=n.useRef(null),u=n.useRef({state:"idle"}),D=n.useRef(null),w=n.useRef({x:0,y:0}),d=n.useRef({x:0,y:0}),N=n.useRef(0),o=n.useRef([]),O=n.useRef(null),I=n.useCallback(t=>{m.current&&(d.current=t,m.current.style.transform=`translate3d(${t.x}px, ${t.y}px, 0)`)},[]),y=n.useCallback(()=>{const t=m.current;if(!t)return{"top-left":v,"top-right":v,"bottom-left":v,"bottom-right":v};const x=O.current?.width??t.offsetWidth??0,h=O.current?.height??t.offsetHeight??0,S=window.innerWidth-document.documentElement.clientWidth;function $(i){const p=i.includes("right"),L=i.includes("bottom");return{x:p?window.innerWidth-S-W-x:W,y:L?window.innerHeight-W-h:W}}const P=$(e);function U(i){const p=$(i);return{x:p.x-P.x,y:p.y-P.y}}return{"top-left":U("top-left"),"top-right":U("top-right"),"bottom-left":U("bottom-left"),"bottom-right":U("bottom-right")}},[e]),z=n.useCallback(t=>{const x=m.current;if(!x)return;const h=t.translation.x-d.current.x,S=t.translation.y-d.current.y;if(Math.sqrt(h*h+S*S)<.5){G(t.corner),d.current=v,x.style.transition="",x.style.transform=B,u.current={state:"idle"},g(!1);return}const $=P=>{P.propertyName==="transform"&&(x.removeEventListener("transitionend",$),G(t.corner),t.corner===e?(d.current=v,x.style.transition="",x.style.transform=B,u.current={state:"idle"},g(!1)):(u.current={state:"animating"},E.current=t.corner,r(t.corner)))};x.style.transition=ae,x.addEventListener("transitionend",$),I(t.translation)},[I,e]),f=n.useCallback(()=>{u.current.state==="drag"?(m.current?.releasePointerCapture(u.current.pointerId),u.current={state:"animating"}):u.current={state:"idle"},D.current&&(D.current(),D.current=null),o.current=[],c(!1),O.current=null,m.current?.classList.remove("dev-tools-grabbing"),document.body.style.removeProperty("user-select"),document.body.style.removeProperty("-webkit-user-select")},[]);n.useLayoutEffect(()=>{if(E.current===e){const t=m.current;t&&u.current.state==="animating"&&(d.current=v,t.style.transition="",t.style.transform=B,u.current={state:"idle"},g(!1),E.current=null)}},[e]),n.useLayoutEffect(()=>()=>{f()},[f]);const J=n.useCallback(t=>{const x=t.target;if(x.tagName==="A"||x.closest("a")||t.button!==0)return;const h=m.current;if(!h)return;O.current={width:h.offsetWidth,height:h.offsetHeight},w.current={x:t.clientX,y:t.clientY};const S=h.style.transform;if(S&&S!=="none"&&S!==B){const i=S.match(/translate3d\(([^,]+)px,\s*([^,]+)px/);i&&(d.current={x:parseFloat(i[1])||0,y:parseFloat(i[2])||0})}else d.current=v;u.current={state:"press"},o.current=[],N.current=Date.now();const $=i=>{if(u.current.state==="press"){const Y=i.clientX-w.current.x,K=i.clientY-w.current.y;if(Math.sqrt(Y*Y+K*K)<se)return;u.current={state:"drag",pointerId:i.pointerId};try{h.setPointerCapture(i.pointerId)}catch{}h.style.transition="none",h.classList.add("dev-tools-grabbing"),document.body.style.userSelect="none",document.body.style.webkitUserSelect="none",c(!0),I({x:d.current.x+Y,y:d.current.y+K}),w.current={x:i.clientX,y:i.clientY};return}if(u.current.state!=="drag")return;const p={x:i.clientX,y:i.clientY},L=p.x-w.current.x,M=p.y-w.current.y;w.current=p,I({x:d.current.x+L,y:d.current.y+M});const H=Date.now();H-N.current>=ce&&(o.current=[...o.current.slice(-4),{position:p,timestamp:H}],N.current=H)},P=()=>{if(u.current.state==="drag"){const i=pe(o.current),p=y();if(f(),!m.current)return;const L=le({x:d.current.x+Z(i.x),y:d.current.y+Z(i.y)},p),M=p[L];g(!0),z({corner:L,translation:M})}else f()},U=i=>{const p=i.target,L=p.tagName==="BUTTON"||p.closest("button"),M=p.tagName==="A"||p.closest("a");u.current.state==="animating"&&!L&&!M&&(i.preventDefault(),i.stopPropagation())};window.addEventListener("pointermove",$),window.addEventListener("pointerup",P,{once:!0}),window.addEventListener("pointercancel",f,{once:!0}),h.addEventListener("click",U),D.current&&D.current(),D.current=()=>{window.removeEventListener("pointermove",$),window.removeEventListener("pointerup",P),window.removeEventListener("pointercancel",f),h.removeEventListener("click",U)}},[f,I,z,y]);return{corner:e,isDragging:s,cornerStyle:ue(e),containerRef:m,onPointerDown:J,preventClick:l,isInitialized:C}}const me=10*1e3;function he(){const e=te(),r=n.useRef(Date.now()),[,s]=n.useReducer(c=>c+1,0);return n.useEffect(()=>{const c=new AbortController;return window.addEventListener("focus",async()=>{const l=e.__internal_environment;if(!l)return;if(l.authConfig.claimedAt!==null)return c.abort();if(Date.now()<r.current+me||document.visibilityState!=="visible")return;const g=2;for(let C=0;C<g;C++){const{authConfig:{claimedAt:R}}=await l.fetch();if(r.current=Date.now(),R!==null){s();break}}},{signal:c.signal}),()=>{c.abort()}},[]),ie()}function ge(e){try{return e()}catch{return"https://dashboard.clerk.com/last-active"}}const X="18rem",xe="220ms",be="180ms",F="cubic-bezier(0.2, 0, 0, 1)",k=b`
  margin: 0;
  padding: 0;
  box-sizing: border-box;
  background: none;
  border: none;
  font-family:
    -apple-system,
    BlinkMacSystemFont,
    avenir next,
    avenir,
    segoe ui,
    helvetica neue,
    helvetica,
    Cantarell,
    Ubuntu,
    roboto,
    noto,
    arial,
    sans-serif;
  font-size: 1rem;
  font-weight: 400;
  line-height: 1.5;
  text-decoration: none;
  color: inherit;
  appearance: none;
`;function T(e){return e?xe:be}const V=b`
  ${k};
  margin: 0.75rem 0 0;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 1.75rem;
  padding: 0.25rem 0.625rem;
  border-radius: 0.375rem;
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.12px;
  color: #fde047;
  text-shadow: 0px 1px 2px rgba(0, 0, 0, 0.32);
  white-space: nowrap;
  user-select: none;
  cursor: pointer;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0) 30.5%, rgba(0, 0, 0, 0.05) 100%), #454545;
  box-shadow:
    0px 0px 0px 1px rgba(255, 255, 255, 0.04) inset,
    0px 1px 0px 0px rgba(255, 255, 255, 0.04) inset,
    0px 0px 0px 1px rgba(0, 0, 0, 0.12),
    0px 1.5px 2px 0px rgba(0, 0, 0, 0.48),
    0px 0px 4px 0px rgba(243, 107, 22, 0) inset;
  outline: none;
  &:hover {
    background: #4b4b4b;
    transition: background-color 120ms ease-in-out;

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  }
  &:focus-visible {
    outline: 2px solid #6c47ff;
    outline-offset: 2px;
  }
`,ye={idle:{triggerWidth:"14.25rem",title:"Configure your application",description:_(re,{children:[a("p",{children:"Temporary API keys are enabled so you can get started immediately."}),a("ul",{children:["Add SSO connections (eg. GitHub)","Set up B2B authentication","Enable MFA"].map(e=>a("li",{children:e},e))}),a("p",{children:"Access the dashboard to customize auth settings and explore Clerk features."})]}),cta:{kind:"link",text:"Configure your application",href:({claimUrl:e})=>e}},userCreated:{triggerWidth:"15.75rem",title:"You've created your first user!",description:a("p",{children:"Head to the dashboard to customize authentication settings, view user info, and explore more features."}),cta:{kind:"link",text:"Configure your application",href:({claimUrl:e})=>e}},claimed:{triggerWidth:"14.25rem",title:"Missing environment keys",description:a("p",{children:"You claimed this application but haven't set keys in your environment. Get them from the Clerk Dashboard."}),cta:{kind:"link",text:"Get API keys",href:({claimUrl:e})=>e}},completed:{triggerWidth:"10.5rem",title:"Your app is ready",description:({appName:e,instanceUrl:r})=>_("p",{children:["Your application"," ",a("a",{href:r,target:"_blank",rel:"noopener noreferrer",children:e})," ","has been configured. You may now customize your settings in the Clerk dashboard."]}),cta:{kind:"action",text:"Dismiss",onClick:e=>{e?.().then(()=>{window.location.reload()})}}}};function we(e,r,s){return r?"completed":e?"claimed":s?"userCreated":"idle"}function ke(e,r){const s=ye[e],c=typeof s.description=="function"?s.description({appName:r.appName,instanceUrl:r.instanceUrl}):s.description,l=s.cta,g=l.kind==="link"?{kind:"link",text:l.text,href:typeof l.href=="function"?l.href({claimUrl:r.claimUrl,instanceUrl:r.instanceUrl}):l.href}:{kind:"action",text:l.text,onClick:()=>l.onClick(r.onDismiss)};return{state:e,triggerWidth:s.triggerWidth,title:s.title,description:c,cta:g}}function ve(e){const r=n.useId(),s=he(),{isDragging:c,cornerStyle:l,containerRef:g,onPointerDown:C,preventClick:R,isInitialized:E}=fe(),m=!!s.authConfig.claimedAt,u=typeof e.onDismiss=="function"&&m,{isSignedIn:D}=ne(),w=s.displayConfig.applicationName,d=n.useMemo(()=>{if(m)return e.copyKeysUrl;const f=new URL(e.claimUrl);return f.searchParams.append("return_url",window.location.href),f.href},[m,e.copyKeysUrl,e.claimUrl]),N=n.useMemo(()=>ge(()=>{const f=ee(e.copyKeysUrl);return new URL(`${f.baseDomain}/apps/${f.appId}/instances/${f.instanceId}/user-authentication/email-phone-username`).href}),[e.copyKeysUrl]),[o,O]=n.useState(!0),I=we(m,u,!!D),y=n.useMemo(()=>ke(I,{appName:w,instanceUrl:N,claimUrl:d,onDismiss:e.onDismiss}),[I,w,N,d,e.onDismiss]),z=y.cta.kind==="link"?a("a",{href:y.cta.href,target:"_blank",rel:"noopener noreferrer",css:V,children:y.cta.text}):a("button",{type:"button",onClick:y.cta.onClick,css:V,children:y.cta.text});return _("div",{ref:g,onPointerDown:o?void 0:C,style:{...l,opacity:E?void 0:0},"data-expanded":o,css:b`
        ${k};
        position: fixed;
        z-index: 2147483647;
        border-radius: ${o?"0.75rem":"2.5rem"};
        background-color: #1f1f1f;
        box-shadow:
          0px 0px 0px 0.5px #2f3037 inset,
          0px 1px 0px 0px rgba(255, 255, 255, 0.08) inset,
          0px 0px 0.8px 0.8px rgba(255, 255, 255, 0.2) inset,
          0px 0px 0px 0px rgba(255, 255, 255, 0.72),
          0px 16px 36px -6px rgba(0, 0, 0, 0.36),
          0px 6px 16px -2px rgba(0, 0, 0, 0.2);
        height: auto;
        isolation: isolate;
        transform: translateZ(0);
        backface-visibility: hidden;
        width: ${o?X:y.triggerWidth};
        cursor: ${c?"grabbing":o?"default":"grab"};
        touch-action: none;
        transition: ${c?"none":E?`width ${T(o)} ${F}, border-radius ${T(o)} cubic-bezier(0.2, 0, 0, 1)`:"none"};

        @media (prefers-reduced-motion: reduce) {
          transition: none;
        }
        &:has(button:focus-visible) {
          outline: 2px solid #6c47ff;
          outline-offset: 2px;
        }
        &::before {
          content: '';
          pointer-events: none;
          position: absolute;
          inset: 0;
          border-radius: inherit;
          background-image: linear-gradient(180deg, rgba(255, 255, 255, 1) 0%, rgba(255, 255, 255, 0) 100%);
          opacity: 0.16;
          transition: opacity ${T(o)} ${F};

          @media (prefers-reduced-motion: reduce) {
            transition: none;
          }
        }
        &[data-expanded='true']::before,
        &:hover::before {
          opacity: 0.2;
        }
      `,children:[_("button",{type:"button","aria-label":"Keyless prompt","aria-controls":r,"aria-expanded":o,onClick:()=>{R||O(f=>!f)},css:b`
          ${k};
          display: flex;
          align-items: center;
          width: 100%;
          border-radius: inherit;
          padding-inline: 0.75rem;
          gap: 0.25rem;
          height: 2.5rem;
          outline: none;
          cursor: pointer;
          user-select: none;
        `,children:[_("svg",{css:b`
            width: 1rem;
            height: 1rem;
            flex-shrink: 0;
          `,fill:"none",viewBox:"0 0 128 128",children:[a("circle",{cx:"64",cy:"64",r:"20",fill:"#fff"}),a("path",{fill:"#fff",fillOpacity:".4",d:"M99.572 10.788c1.999 1.34 2.17 4.156.468 5.858L85.424 31.262c-1.32 1.32-3.37 1.53-5.033.678A35.846 35.846 0 0 0 64 28c-19.882 0-36 16.118-36 36a35.846 35.846 0 0 0 3.94 16.391c.851 1.663.643 3.712-.678 5.033L16.646 100.04c-1.702 1.702-4.519 1.531-5.858-.468C3.974 89.399 0 77.163 0 64 0 28.654 28.654 0 64 0c13.163 0 25.399 3.974 35.572 10.788Z"}),a("path",{fill:"#fff",d:"M100.04 111.354c1.702 1.702 1.531 4.519-.468 5.858C89.399 124.026 77.164 128 64 128c-13.164 0-25.399-3.974-35.572-10.788-2-1.339-2.17-4.156-.468-5.858l14.615-14.616c1.322-1.32 3.37-1.53 5.033-.678A35.847 35.847 0 0 0 64 100a35.846 35.846 0 0 0 16.392-3.94c1.662-.852 3.712-.643 5.032.678l14.616 14.616Z"})]}),a("span",{css:b`
            ${k};
            font-size: 0.875rem;
            font-weight: 500;
            color: #d9d9d9;
            white-space: nowrap;
          `,children:y.title}),a("svg",{css:b`
            width: 1rem;
            height: 1rem;
            flex-shrink: 0;
            color: #d9d9d9;
            margin-inline-start: auto;
            opacity: ${o?.5:0};
            transition: opacity ${T(o)} ease-out;

            @media (prefers-reduced-motion: reduce) {
              transition: none;
            }
            ${o&&b`
              button:hover & {
                opacity: 1;
              }
            `}
          `,viewBox:"0 0 16 16",fill:"none","aria-hidden":"true",xmlns:"http://www.w3.org/2000/svg",children:a("path",{d:"M3.75 8H12.25",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round",strokeLinejoin:"round"})})]}),a("div",{id:r,...oe(!o),css:b`
          ${k};
          display: grid;
          grid-template-rows: ${o?"1fr":"0fr"};
          transition: grid-template-rows ${T(o)} ${F};

          @media (prefers-reduced-motion: reduce) {
            transition: none;
          }
        `,children:a("div",{css:b`
            ${k};
            min-height: 0;
            overflow: hidden;
          `,children:_("div",{css:b`
              ${k};
              width: ${X};
              padding-inline: 0.75rem;
              padding-block-end: 0.75rem;
              opacity: ${o?1:0};
              transition: opacity ${T(o)} ${F};

              @media (prefers-reduced-motion: reduce) {
                transition: none;
              }
            `,children:[a("div",{css:b`
                ${k};
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
                & ul {
                  ${k};
                  list-style: disc;
                  padding-left: 1rem;
                }
                & p,
                & li {
                  ${k};
                  color: #b4b4b4;
                  font-size: 0.8125rem;
                  font-weight: 400;
                  line-height: 1rem;
                  text-wrap: pretty;
                }
                & a {
                  color: #fde047;
                  font-weight: 500;
                  outline: none;
                  text-decoration: underline;
                  &:focus-visible {
                    outline: 2px solid #6c47ff;
                    outline-offset: 2px;
                  }
                }
              `,children:y.description}),z]})})})]})}function _e(e){return a(Q,{children:a(ve,{...e})})}export{_e as KeylessPrompt,we as getCurrentState,ke as getResolvedContent};
