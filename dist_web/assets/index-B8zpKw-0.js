import{u as L}from"./OptionsContext-B8YMK5tr.js";import{u as U}from"./EnvironmentContext-B9dLVnSe.js";import{InternalThemeProvider as V}from"./index-DafoNVVP.js";import{F as g,e as o}from"./index-CpdMWlkh.js";import{M as D}from"./Modal-Dwrw7UW4.js";import{P as Z}from"./Portal-Cvzmkl9z.js";import{b as d,P as K,a as Y,C as q}from"./shared-D8dmX9-H.js";import{j as e,e as N,r as c,b as i,F as m,R as W,i as H}from"./index--zwhJJ6x.js";import"./underscore-PzdM3hke.js";import"./AppearanceContext-D3b6eaJF.js";import"./utils-V2FbmPWk-CO7FM5J0.js";import"./makeLocalizable-D4zc-mxB.js";import"./localizationKeys-L95TEc06.js";import"./makeCustomizable-Bzmt06QU.js";import"./url-BW4YVlrT.js";import"./floating-ui.react-POeqYDO2.js";import"./index-CK_CQX1s.js";import"./index-2jgnr1E2.js";import"./useScrollLock-BfxNPW2e.js";import"./index-CaD9Z-99.js";import"./RouteContext-Bwwnxlip.js";const J="https://dashboard.clerk.com/~/organizations-settings",Q=({caller:t,onSuccess:a,onClose:s})=>{const r=N(),[p,h]=c.useState(!1),[l,u]=c.useState(!1),[f,A]=c.useState(null),[v,B]=c.useState(!1),k=c.useRef(null),w=U(),$=c.useId(),_=L(),b=_.__internal_keyless_claimKeylessApplicationUrl,M=_.__internal_keyless_copyInstanceKeysUrl,j=!!b&&!!M,G=w.authConfig.claimedAt!==null,y=l&&j&&!G,T=!t.startsWith("use"),I=typeof w?.organizationSettings.forceOrganizationSelection<"u",F=()=>{h(!0);const n={enable_organizations:!0};I&&(n.organization_allow_personal_accounts=v),w.__internal_enableEnvironmentSetting(n).then(async()=>{A((await r.user?.getOrganizationMemberships())?.data[0]?.organization.name??null),u(!0),h(!1)}).catch(()=>{h(!1)})};return e(Z,{children:e(D,{canCloseModal:!1,containerSx:()=>({alignItems:"center"}),initialFocusRef:k,children:i(K,{sx:()=>({display:"flex",flexDirection:"column",width:"30rem",maxWidth:"calc(100vw - 2rem)"}),children:[i(g,{direction:"col",sx:n=>({padding:`${n.sizes.$4} ${n.sizes.$6}`,paddingBottom:n.sizes.$4,gap:n.sizes.$2}),children:[i(g,{as:"header",align:"center",sx:n=>({gap:n.sizes.$2}),children:[e(re,{isEnabled:l}),e("h1",{css:[d,o`
                    color: white;
                    font-size: 0.875rem;
                    font-weight: 500;
                    outline: none;
                  `],tabIndex:-1,ref:k,children:l?"Organizations feature enabled":"Organizations feature required"})]}),e(g,{direction:"col",align:"start",sx:n=>({gap:n.sizes.$0x5}),children:l?i("p",{css:[d,o`
                      color: #b4b4b4;
                      font-size: 0.8125rem;
                      font-weight: 400;
                      line-height: 1.3;
                    `],children:[y?f?`Organizations are now enabled and a default organization named "${f}" was created. Claim your application to save this configuration and access the full dashboard.`:"Organizations are now enabled! Claim your application to save this configuration and access the full dashboard.":r.user&&f?`The Organizations feature has been enabled for your application. A default organization named "${f}" was created automatically. You can manage or rename it in your`:"The Organizations feature has been enabled for your application. You can manage it in your",!y&&i(m,{children:[" ",e(C,{href:J,target:"_blank",rel:"noopener noreferrer",children:"dashboard"}),"."]})]}):i(m,{children:[i("p",{id:$,css:[d,o`
                        color: #b4b4b4;
                        font-size: 0.8125rem;
                        font-weight: 400;
                        line-height: 1.23;
                      `],children:["Enable Organizations to use"," ",e("code",{css:[d,o`
                          font-size: 0.75rem;
                          color: white;
                          font-family: monospace;
                          line-height: 1.23;
                        `],children:T?`<${t} />`:t})," "]}),e(C,{href:"https://clerk.com/docs/guides/organizations/overview",target:"_blank",rel:"noopener noreferrer",children:"Learn more"})]})}),I&&!l&&e(g,{sx:n=>({marginTop:n.sizes.$2}),direction:"col",children:i(te,{value:v?"optional":"required",onChange:n=>B(n==="optional"),labelledBy:$,children:[e(P,{value:"required",label:i(g,{wrap:"wrap",sx:n=>({columnGap:n.sizes.$2,rowGap:n.sizes.$1}),children:[e("span",{children:"Membership required"}),e(ee,{children:"Standard"})]}),description:i(m,{children:[e("span",{className:"block",children:"Users need to belong to at least one organization."}),e("span",{children:"Common for most B2B SaaS applications"})]})}),e(P,{value:"optional",label:"Membership optional",description:"Users can work outside of an organization with a personal account"})]})})]}),e("span",{css:o`
              height: 1px;
              display: block;
              width: calc(100% - 2px);
              margin-inline: auto;
              background-color: #151515;
              box-shadow: 0px 1px 0px 0px #424242;
            `}),e(g,{justify:"center",sx:n=>({padding:`${n.sizes.$4} ${n.sizes.$6}`,gap:n.sizes.$3,justifyContent:"flex-end"}),children:l?y?i(m,{children:[e(x,{variant:"outline",onClick:()=>{a?.()},children:r.user?"Continue":"I’ll do it later"}),e(C,{href:b,target:"_blank",rel:"noopener noreferrer",onClick:n=>{if(b){const O=new URL(b);O.searchParams.append("return_url",window.location.href),n.currentTarget.href=O.href}r.__internal_closeEnableOrganizationsPrompt?.()},css:o`
                      ${S}
                      ${E}
                      color: #fde047;
                      text-decoration: none;
                    `,children:"Claim your application"})]}):e(x,{variant:"solid",onClick:()=>{r.user?a?.():(r.redirectToSignIn(),r.__internal_closeEnableOrganizationsPrompt?.())},children:r.user?"Continue":"Sign in to continue"}):i(m,{children:[e(x,{variant:"outline",onClick:()=>{r?.__internal_closeEnableOrganizationsPrompt?.(),s?.()},children:"I'll remove it myself"}),e(x,{variant:"solid",onClick:F,disabled:p,children:"Enable Organizations"})]})})]})})})},_e=t=>e(V,{children:e(Q,{...t})}),S=o`
  ${d};
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 1.75rem;
  padding: 0.375rem 0.625rem;
  border-radius: 0.375rem;
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.12px;
  color: white;
  text-shadow: 0px 1px 2px rgba(0, 0, 0, 0.32);
  white-space: nowrap;
  user-select: none;
  color: white;
  outline: none;

  &:not(:disabled) {
    transition: 120ms ease-in-out;
    transition-property: background-color, border-color, box-shadow, color;
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  &:focus-visible:not(:disabled) {
    outline: 2px solid white;
    outline-offset: 2px;
  }
`,E=o`
  background: linear-gradient(180deg, rgba(0, 0, 0, 0) 30.5%, rgba(0, 0, 0, 0.05) 100%), #454545;
  box-shadow:
    0 0 3px 0 rgba(253, 224, 71, 0) inset,
    0 0 0 1px rgba(255, 255, 255, 0.04) inset,
    0 1px 0 0 rgba(255, 255, 255, 0.04) inset,
    0 0 0 1px rgba(0, 0, 0, 0.12),
    0 1.5px 2px 0 rgba(0, 0, 0, 0.48);

  &:hover:not(:disabled) {
    background: linear-gradient(180deg, rgba(0, 0, 0, 0) 30.5%, rgba(0, 0, 0, 0.15) 100%), #5f5f5f;
    box-shadow:
      0 0 3px 0 rgba(253, 224, 71, 0) inset,
      0 0 0 1px rgba(255, 255, 255, 0.04) inset,
      0 1px 0 0 rgba(255, 255, 255, 0.04) inset,
      0 0 0 1px rgba(0, 0, 0, 0.12),
      0 1.5px 2px 0 rgba(0, 0, 0, 0.48);
  }
`,X={solid:E,outline:o`
  border: 1px solid rgba(118, 118, 132, 0.25);
  background: rgba(69, 69, 69, 0.1);

  &:hover:not(:disabled) {
    border-color: rgba(118, 118, 132, 0.5);
  }
`},x=c.forwardRef(({variant:t="solid",...a},s)=>e("button",{ref:s,type:"button",css:[S,X[t]],...a})),ee=({children:t})=>e("span",{css:o`
        ${d};
        display: inline-flex;
        align-items: center;
        padding: 0.125rem 0.375rem;
        border-radius: 0.25rem;
        font-size: 0.6875rem;
        font-weight: 500;
        line-height: 1.23;
        background-color: #ebebeb;
        color: #2b2b34;
        white-space: nowrap;
      `,children:t}),[ne,oe]=H("RadioGroupContext"),te=({value:t,onChange:a,children:s,labelledBy:r})=>{const p=c.useId(),h=W.useMemo(()=>({value:{name:p,value:t,onChange:a}}),[p,t,a]);return e(ne.Provider,{value:h,children:e(g,{role:"radiogroup",direction:"col",gap:3,"aria-orientation":"vertical","aria-labelledby":r,children:s})})},z="1rem",R="0.5rem",P=({value:t,label:a,description:s})=>{const{name:r,value:p,onChange:h}=oe(),l=c.useId(),u=t===p;return i(g,{direction:"col",gap:1,children:[i("label",{css:o`
          ${d};
          display: flex;
          align-items: flex-start;
          gap: ${R};
          cursor: pointer;
          user-select: none;

          &:has(input:focus-visible) > span:first-of-type {
            outline: 2px solid white;
            outline-offset: 2px;
          }

          &:hover:has(input:not(:checked)) > span:first-of-type {
            background-color: rgba(255, 255, 255, 0.08);
          }

          &:hover:has(input:checked) > span:first-of-type {
            background-color: rgba(108, 71, 255, 0.8);
            background-color: color-mix(in srgb, #6c47ff 80%, transparent);
          }
        `,children:[e("input",{type:"radio",name:r,value:t,checked:u,onChange:()=>h(t),"aria-describedby":s?l:void 0,css:o`
            ${d};
            position: absolute;
            width: 1px;
            height: 1px;
            padding: 0;
            margin: -1px;
            overflow: hidden;
            clip: rect(0, 0, 0, 0);
            white-space: nowrap;
            border-width: 0;
          `}),e("span",{"aria-hidden":"true",css:o`
            ${d};
            position: relative;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: ${z};
            height: ${z};
            margin-top: 0.125rem;
            flex-shrink: 0;
            border-radius: 50%;
            border: 1px solid rgba(255, 255, 255, 0.3);
            background-color: transparent;
            transition: 120ms ease-in-out;
            transition-property: border-color, background-color, box-shadow;

            ${u&&o`
              border-width: 2px;
              border-color: #6c47ff;
              background-color: #6c47ff;
              background-color: color-mix(in srgb, #6c47ff 100%, transparent);
              box-shadow: 0 0 0 2px rgba(108, 71, 255, 0.2);
            `}

            &::after {
              content: '';
              position: absolute;
              width: 0.375rem;
              height: 0.375rem;
              border-radius: 50%;
              background-color: white;
              opacity: ${u?1:0};
              transform: scale(${u?1:0});
              transition: 120ms ease-in-out;
              transition-property: opacity, transform;
            }
          `}),e("span",{css:[d,o`
              font-size: 0.875rem;
              font-weight: 500;
              line-height: 1.25;
              color: white;
            `],children:a})]}),s&&e("span",{id:l,css:[d,o`
              padding-inline-start: calc(${z} + ${R});
              font-size: 0.75rem;
              line-height: 1.33;
              color: #c3c3c6;
              text-wrap: pretty;
            `],children:s})]})},C=c.forwardRef(({children:t,css:a,...s},r)=>e("a",{ref:r,...s,css:[d,o`
            color: #a8a8ff;
            font-size: inherit;
            font-weight: 500;
            line-height: 1.3;
            font-size: 0.8125rem;
            min-width: 0;
          `,a],children:t})),re=({isEnabled:t})=>{const[a,s]=c.useState(0);c.useLayoutEffect(()=>{if(t){s(u=>u===0?180:0);return}const l=setInterval(()=>{s(u=>u===0?180:0)},2e3);return()=>clearInterval(l)},[t]);let r="idle",p="warning";t&&(a===0?(r="success",p="warning"):(p="success",r="idle"));const h=l=>{switch(l){case"idle":return e(q,{});case"success":return e(Y,{css:o`
              width: 1.25rem;
              height: 1.25rem;
            `});case"warning":return i("svg",{css:o`
              width: 1.25rem;
              height: 1.25rem;
            `,viewBox:"0 0 20 20",fill:"none",xmlns:"http://www.w3.org/2000/svg",children:[e("path",{opacity:"0.2",d:"M17.25 10C17.25 14.0041 14.0041 17.25 10 17.25C5.99594 17.25 2.75 14.0041 2.75 10C2.75 5.99594 5.99594 2.75 10 2.75C14.0041 2.75 17.25 5.99594 17.25 10Z",fill:"#EAB308"}),e("path",{fillRule:"evenodd",clipRule:"evenodd",d:"M10 3.5C6.41015 3.5 3.5 6.41015 3.5 10C3.5 13.5899 6.41015 16.5 10 16.5C13.5899 16.5 16.5 13.5899 16.5 10C16.5 6.41015 13.5899 3.5 10 3.5ZM2 10C2 5.58172 5.58172 2 10 2C14.4183 2 18 5.58172 18 10C18 14.4183 14.4183 18 10 18C5.58172 18 2 14.4183 2 10Z",fill:"#EAB308"}),e("path",{fillRule:"evenodd",clipRule:"evenodd",d:"M10 6C10.5523 6 11 6.44772 11 7V9C11 9.55228 10.5523 10 10 10C9.44772 10 9 9.55228 9 9V7C9 6.44772 9.44772 6 10 6Z",fill:"#EAB308"}),e("path",{fillRule:"evenodd",clipRule:"evenodd",d:"M10 12C10.5523 12 11 12.4477 11 13V13.01C11 13.5623 10.5523 14.01 10 14.01C9.44772 14.01 9 13.5623 9 13.01V13C9 12.4477 9.44772 12 10 12Z",fill:"#EAB308"})]})}};return e("div",{css:o`
        perspective: 1000px;
        width: 1.25rem;
        height: 1.25rem;
      `,children:i("div",{css:o`
          position: relative;
          width: 100%;
          height: 100%;
          transform-style: preserve-3d;
          transition: transform 0.6s ease-in-out;
          transform: rotateY(${a}deg);

          @media (prefers-reduced-motion: reduce) {
            transition: none;
          }
        `,children:[e("span",{"aria-hidden":!0,css:o`
            position: absolute;
            width: 100%;
            height: 100%;
            backface-visibility: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
            -webkit-font-smoothing: antialiased;
            transform: rotateY(0deg);
          `,children:h(r)}),e("span",{"aria-hidden":!0,css:o`
            position: absolute;
            width: 100%;
            height: 100%;
            backface-visibility: hidden;
            transform: rotateY(180deg);
            display: flex;
            align-items: center;
            justify-content: center;
            -webkit-font-smoothing: antialiased;
          `,children:h(p)})]})})};export{_e as EnableOrganizationsPrompt};
