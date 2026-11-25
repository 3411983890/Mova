const page=figma.currentPage;
const board=await figma.getNodeByIdAsync('10:9'),row=await figma.getNodeByIdAsync('10:11');
const states=await Promise.all(['21:1473','21:1665','21:2155'].map(id=>figma.getNodeByIdAsync(id)));
if(page.children.some(n=>n.name==='04 · Chat / New conversation') || row.children.some(c=>c.children.length>1)) throw new Error('Overview already populated; inspect before applying again.');
const fonts=new Map();
for(const f of states) for(const t of f.findAllWithCriteria({types:['TEXT']})) for(const s of t.getStyledTextSegments(['fontName'])) fonts.set(s.fontName.family+s.fontName.style,{family:s.fontName.family,style:s.fontName.style});
fonts.set('Noto Sans SCMedium',{family:'Noto Sans SC',style:'Medium'});
await Promise.all([...fonts.values()].map(f=>figma.loadFontAsync(f)));
const created=[],mutated=[],links=[];
const blank=states[0].clone();created.push(blank.id);blank.name='04 · Chat / New conversation';blank.x=1616;blank.y=1460;
for(const n of [...blank.children]) if(n.name==='Message / User'||n.name==='Message / Mova') n.remove();
for(const n of blank.findAll(n=>('reactions' in n)&&n.reactions.length)) {await n.setReactionsAsync([]);mutated.push(n.id);}
const welcome=figma.createAutoLayout('VERTICAL');created.push(welcome.id);blank.appendChild(welcome);welcome.name='Welcome';welcome.resize(362,160);welcome.x=20;welcome.y=304;welcome.fills=[];welcome.counterAxisAlignItems='CENTER';welcome.itemSpacing=16;
const label=await figma.variables.importVariableByKeyAsync('be4259bb75a4279fc39e5100262719271f57a243'),mutedVar=await figma.variables.importVariableByKeyAsync('ee3cc41d082224cc947f918704ead1f41ef41e80');
function txt(value,size,color,family,style) {const t=figma.createText();created.push(t.id);t.fontName={family,style};t.fontSize=size;t.lineHeight={unit:'PIXELS',value:size*1.5};t.characters=value;t.fills=[figma.variables.setBoundVariableForPaint({type:'SOLID',color:{r:1,g:1,b:1}},'color',color)];welcome.appendChild(t);return t;}
txt('Mova',40,label,'SF Pro','Semibold');txt('今天，有什么想聊的？',21,label,'Noto Sans SC','Medium');txt('随时提问，让想法慢慢清晰。',14,mutedVar,'Noto Sans SC','Regular');
async function link(from,to) {await from.setReactionsAsync([{trigger:{type:'ON_CLICK'},actions:[{type:'NODE',destinationId:to.id,navigation:'NAVIGATE',transition:{type:'DISSOLVE',duration:.2,easing:{type:'EASE_OUT'}}}]}]);mutated.push(from.id);links.push({from:from.id,to:to.id});}
for(const id of ['21:1556','21:1722','21:2331']) await link(await figma.getNodeByIdAsync(id),blank);
await (await figma.getNodeByIdAsync('21:1727')).setReactionsAsync([]);mutated.push('21:1727');
await link(await figma.getNodeByIdAsync('21:2115'),states[0]);
const blankMenu=blank.findAllWithCriteria({types:['FRAME']}).find(n=>n.name==='Action / panel-left');await link(blankMenu,states[2]);
const gallery=[],counts=[];
for(let i=0;i<states.length;i++) {
  const f=states[i].clone();created.push(f.id);row.children[i].appendChild(f);f.name=states[i].name+' / Design';f.resize(402,874);states[i].y=1460;mutated.push(states[i].id);gallery.push({id:f.id,name:f.name,width:f.width,height:f.height});
  const nodes=f.findAll(()=>true),types={};for(const n of nodes)types[n.type]=(types[n.type]??0)+1;
  counts.push({id:f.id,total:nodes.length,counts:types,imageNodes:nodes.filter(n=>'fills'in n&&Array.isArray(n.fills)&&n.fills.some(p=>p.type==='IMAGE')).map(n=>({id:n.id,name:n.name,type:n.type,width:n.width,height:n.height}))});
}
board.name='00 · Mova Mobile / Design overview';mutated.push(board.id);figma.currentPage.selection=[board];figma.viewport.scrollAndZoomIntoView([board]);
return {createdNodeIds:created,mutatedNodeIds:mutated,overview:board.id,gallery,newConversation:blank.id,links,canonicalStates:states.map(s=>({id:s.id,parent:s.parent.id,x:s.x,y:s.y})),counts};
