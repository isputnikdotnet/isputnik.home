/* Standalone design prototype. All records are fictional and stay in this page. */
const paths = {
  orbit:'<circle cx="12" cy="12" r="5"/><ellipse cx="12" cy="12" rx="11" ry="5" transform="rotate(-35 12 12)"/><path d="M10 8l3 2-2 3 2 3"/>',
  home:'<path d="m3 10 9-7 9 7v11h-6v-7H9v7H3z"/>',
  activity:'<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  library:'<path d="M4 4h4v16H4zM11 4h4v16h-4zM18 5l4 14"/>',
  users:'<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 5v2"/>',
  shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>',
  tool:'<path d="M14 6a5 5 0 0 0-7 6L2 18l4 4 6-6a5 5 0 0 0 6-7l-4 4-3-3z"/>',
  settings:'<path d="m9 3-1 3-3 1 1 4-2 2 2 3 3 1 1 4h4l1-4 3-1 2-3-2-2 1-4-3-1-1-3z"/><circle cx="12" cy="12" r="3"/>',
  chevron:'<path d="m9 5 7 7-7 7"/>',
  down:'<path d="m6 9 6 6 6-6"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  folder:'<path d="M3 7V4h6l2 3h10v13H3z"/>',
  book:'<path d="M12 6v15M12 6C9 3 5 3 2 4v15c4-1 7 0 10 2 3-2 6-3 10-2V4c-3-1-7-1-10 2z"/>',
  audio:'<path d="M4 14v-2a8 8 0 0 1 16 0v2M4 13H2v7h5v-7zM20 13h2v7h-5v-7z"/>',
  photo:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
  video:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 4l3 5M14 4l3 5m-6 3 5 3-5 3z"/>',
  more:'<circle cx="5" cy="12" r=".7"/><circle cx="12" cy="12" r=".7"/><circle cx="19" cy="12" r=".7"/>',
  drive:'<path d="m6 4-4 12v4h20v-4L18 4zM2 16h20M16 18h1M19 18h1"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  tag:'<path d="M3 3h8l11 11-8 8L3 11z"/><circle cx="7.5" cy="7.5" r="1"/>',
  shapes:'<path d="m7 2 5 8H2z"/><rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="18" cy="17" r="4"/>',
  phone:'<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 5h4M11 19h2"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  network:'<rect x="8" y="2" width="8" height="5" rx="1"/><path d="M12 7v6M4 17v-4h16v4"/><rect x="1" y="17" width="6" height="5" rx="1"/><rect x="17" y="17" width="6" height="5" rx="1"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 3"/>',
  box:'<path d="m3 7 9-4 9 4v11l-9 4-9-4zM3 7l9 4 9-4M12 11v11M7 5l10 4"/>',
  map:'<path d="m3 5 6-2 6 3 6-2v16l-6 2-6-3-6 2zM9 3v16M15 6v16"/>',
  globe:'<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  refresh:'<path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.folder}</svg>`;
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const content = document.querySelector('#content');
const dialog = document.querySelector('#editor');
let saveAction = null;
let toastTimer;
const libraryData = [
  {id:1,name:'Family photos',type:'Gallery',icon:'photo',tone:'',size:'186 GB',items:'24,860 items',access:'Family',status:'Up to date',folder:'/media/Photos'},
  {id:2,name:'Audiobooks',type:'Audiobooks',icon:'audio',tone:'sand',size:'42.8 GB',items:'316 books',access:'Family',status:'Up to date',folder:'/media/Audiobooks'},
  {id:3,name:'Ebooks',type:'Ebooks',icon:'book',tone:'blue',size:'3.2 GB',items:'1,248 books',access:'Family',status:'Up to date',folder:'/media/Ebooks'},
  {id:4,name:'Movies',type:'Video · Movies',icon:'video',tone:'',size:'248 GB',items:'124 movies',access:'Adults',status:'Up to date',folder:'/video/Movies'},
  {id:5,name:'TV shows',type:'Video · Shows',icon:'video',tone:'',size:'132 GB',items:'42 shows',access:'Family',status:'Up to date',folder:'/video/Shows'}
];
const syncSettings = {folder:'/media/Personal',quota:'100',eligible:'Every member',address:'https://home.example.test'};
const devices = [
  {name:'Anna’s iPhone',owner:'Anna',contact:'4 minutes ago',network:'Home Wi-Fi',state:'Connected',warn:false},
  {name:'Alex’s Pixel',owner:'Alex',contact:'18 minutes ago',network:'Home Wi-Fi',state:'Connected',warn:false},
  {name:'Family iPad',owner:'Jamie',contact:'8 days ago',network:'Home Wi-Fi',state:'No recent contact',warn:true}
];
const orgData = {categories:[['Fiction','386 books'],['History','142 books'],['Science & nature','96 books'],['For children','208 books']],tags:[['Family','218 uses'],['Summer','84 uses'],['Travel','126 uses'],['Recipes','32 uses']],genres:[['Drama','42 titles'],['Comedy','36 titles'],['Documentary','18 titles'],['Adventure','24 titles']]};
const head = (title, description, action = '') => `<header class="page-head"><div><span class="eyebrow">LIBRARY</span><h1 tabindex="-1">${title}</h1><p>${description}</p></div>${action}</header>`;
const btn = (label, action, arg = '', style = '', glyph = '') => `<button type="button" class="button ${style}" data-action="${action}" data-arg="${esc(arg)}">${glyph ? icon(glyph) : ''}${label}</button>`;
const link = (label, page, glyph = '') => `<a class="button text" href="#${page}">${glyph ? icon(glyph) : ''}${label}${icon('arrow')}</a>`;
const stat = (label, value, detail, glyph) => `<div class="stat"><div class="stat-label">${icon(glyph)}${label}</div><div class="stat-value">${value}<span>${detail}</span></div></div>`;
const field = (label, id, value, type = 'text') => `<label class="field">${label}<input id="${id}" type="${type}" value="${esc(value)}" ${type === 'number' ? 'min="1"' : ''}></label>`;
const hint = (title, body) => `<div class="note"><i>${icon('info')}</i><div><strong>${title}</strong><br>${body}</div></div>`;

function libraryRows() {
  const type = document.querySelector('#library-type')?.value || 'all';
  const query = (document.querySelector('#library-search')?.value || '').toLowerCase();
  const rows = libraryData.filter(l => (type === 'all' || l.type.startsWith(type)) && `${l.name} ${l.type}`.toLowerCase().includes(query));
  document.querySelector('#library-rows').innerHTML = rows.length ? rows.map(l => `<tr>
    <td><div class="name-cell"><span class="type-icon ${l.tone}">${icon(l.icon)}</span><div><strong>${esc(l.name)}</strong><small class="sub">${l.type}</small></div></div></td>
    <td class="hide-small"><span class="pill">${icon(l.access === 'Adults' ? 'lock' : 'users')}${l.access}</span></td>
    <td class="hide-medium"><span class="status">${l.status}</span></td>
    <td class="numeric">${l.size}<small class="sub">${l.items}</small></td>
    <td><div class="row-actions">${btn('Manage','manage',l.id)}<button type="button" class="icon-button" data-action="actions" data-arg="${l.id}" aria-label="More actions for ${esc(l.name)}">${icon('more')}</button></div></td>
  </tr>`).join('') : '<tr><td colspan="5" class="empty">No libraries match your search.</td></tr>';
  document.querySelector('#library-count').textContent = `${rows.length} ${rows.length === 1 ? 'library' : 'libraries'}`;
}
function libraries() {
  content.innerHTML = head('Libraries','Your media libraries, who can use them, and how they’re doing.',btn('Add library','add-library','','primary','plus')) +
    `<div class="stat-strip">${stat('Media libraries',libraryData.length,'across 4 media types','library')}${stat('Library files','612 GB','across your locations','drive')}${stat('Library status','All current','last checked just now','check')}</div>
    <div class="toolbar"><label class="search"><i>${icon('search')}</i><input id="library-search" type="search" placeholder="Search libraries…" aria-label="Search libraries"></label><select id="library-type" aria-label="Filter by media type"><option value="all">All media types</option><option>Gallery</option><option>Audiobooks</option><option>Ebooks</option><option value="Video">Video</option></select><span class="toolbar-note" id="library-count"></span></div>
    <div class="table-card"><table><thead><tr><th>Library</th><th class="hide-small">Access</th><th class="hide-medium">Status</th><th class="numeric">Contents</th><th></th></tr></thead><tbody id="library-rows"></tbody></table><div class="table-foot">${icon('lock')}Personal libraries are private. Manage their destination and limits in <a class="inline-link" href="#device-sync">Device Sync</a>.</div></div>
    <a class="below-link" href="#storage">${icon('folder')}Looking for your folders? Manage library locations in Storage ${icon('arrow')}</a>`;
  libraryRows();
  document.querySelector('#library-search').addEventListener('input', libraryRows);
  document.querySelector('#library-type').addEventListener('change', libraryRows);
}
function organization() {
  content.innerHTML = head('Organization','The right way to organize each kind of content.') + `<div class="cards organization-grid">
    <article class="org-card"><div class="org-icon">${icon('shapes')}</div><h2>Book categories</h2><p>Give your books a clear structure with shared categories and keyword rules.</p><div class="scope"><b>Applies to</b>Ebooks · Audiobooks</div>${btn('Manage categories','organize','categories','','arrow')}</article>
    <article class="org-card"><div class="org-icon">${icon('tag')}</div><h2>Tags</h2><p>Connect related content with flexible labels that work across your collection.</p><div class="scope"><b>Applies to</b>Books · Gallery · Albums · Slideshows<br>Stories · Family-tree people</div>${btn('Manage tags','organize','tags','','arrow')}</article>
    <article class="org-card"><div class="org-icon">${icon('video')}</div><h2>Video genres</h2><p>Organize movies and shows by genre, with rules for imported metadata.</p><div class="scope"><b>Applies to</b>Video libraries · Movies & TV shows</div>${btn('Manage genres','organize','genres','','arrow')}</article>
    </div>${hint('One shared set for each tool','Changes apply across the content types listed above. Gallery video clips can use tags; movies and shows in Video libraries use video genres.')}`;
}
function deviceSync() {
  content.innerHTML = head('Device Sync','Back up photos and videos to personal libraries. Check your devices at a glance.',btn('Setup guide','sync-guide','','','info')) +
    `<div class="setup-ready"><i>${icon('check')}</i><div><strong>Ready for device backups</strong><br>Personal libraries and network access are configured.</div><a class="button text small" href="#device-sync/settings">View settings ${icon('down')}</a></div>
    <div class="stat-strip">${stat('Registered devices','3','across 3 members','phone')}${stat('Personal library storage','68.4 GB',`of ${Number(syncSettings.quota)*3} GB allocated`,'drive')}${stat('Needs attention','1 device','no recent contact','clock')}</div>
    <div class="section-title"><h2>Devices</h2><small>Connection status · private media stays private</small></div>
    <div class="table-card"><table><thead><tr><th>Device / member</th><th class="hide-small">Last contact</th><th class="hide-medium">Network</th><th>Status</th><th></th></tr></thead><tbody>${devices.map((d,i) => `<tr><td><div class="name-cell"><span class="device-dot">${icon('phone')}</span><div><strong>${d.name}</strong><small class="sub">${d.owner}</small></div></div></td><td class="hide-small">${d.contact}</td><td class="hide-medium quiet">${d.network}</td><td><span class="status ${d.warn?'warning':''}">${d.state}</span></td><td>${btn('Details','device',i,'small')}</td></tr>`).join('')}</tbody></table></div>
    <div class="section-title" id="sync-settings"><h2>Sync settings</h2><small>Configure once, then manage as needed</small></div>
    <div class="settings-list"><div class="setting-row"><i>${icon('users')}</i><div><strong>Personal libraries</strong><small>Who can have one, where it lives, and how large it can grow</small></div><span class="value">${syncSettings.eligible} · ${esc(syncSettings.quota)} GB each</span>${btn('Edit','personal-settings','','small')}</div>
    <div class="setting-row"><i>${icon('network')}</i><div><strong>Allowed networks</strong><small>Home Wi-Fi and VPN access for device backups</small></div><span class="value">2 networks allowed</span>${btn('Edit','network-settings','','small')}</div>
    <div class="setting-row"><i>${icon('globe')}</i><div><strong>Server address</strong><small>The address members enter on their devices</small></div><span class="value">Configured</span>${btn('Edit','address-settings','','small')}</div></div>
    <div class="below-link">${icon('info')}Backups add files. Deleting a photo on a device won’t delete the server copy.</div>`;
}
function storage() {
  content.innerHTML = head('Storage','Where your libraries and the app keep their files.') + `<div class="storage-grid">
    <section class="panel"><div class="panel-head"><i>${icon('folder')}</i><div><h2>Library locations</h2><p>Approved folders your libraries can use</p></div>${btn('Add location','add-location','','small','plus')}</div>
    <div class="location"><div class="location-top"><strong>Family media</strong><span class="pill">3 libraries</span></div><p class="path">/media</p><div class="meter"><span style="width:38%"></span></div><div class="meter-caption"><span>380 GB used</span><span>620 GB free of 1 TB</span></div></div>
    <ul class="folder-tree"><li><i>${icon('photo')}</i>Photos<span>Gallery</span></li><li><i>${icon('audio')}</i>Audiobooks<span>Audiobooks</span></li><li><i>${icon('book')}</i>Ebooks<span>Ebooks</span></li></ul>
    <div class="section-kicker">Separate video engine</div><div class="location"><div class="location-top"><strong>Video media</strong><span class="pill">2 libraries</span></div><p class="path">/video</p><small class="quiet">Movies and shows use folders on the video server.</small></div>
    <details class="advanced"><summary>How locations and libraries work</summary><p class="sub">A location is an approved parent folder. A library catalogs a folder inside it. One location can hold several libraries.</p></details></section>
    <div class="storage-right"><section class="panel"><div class="panel-head"><i>${icon('drive')}</i><div><h2>System data</h2><p>Thumbnails, backups and metadata</p></div><span class="pill">Required</span></div><div class="storage-summary"><div><span class="path">/config</span><small>186 GB free of 256 GB</small></div>${btn('Change','system-location','','small')}</div><div class="meter"><span style="width:27%"></span></div><details class="advanced"><summary>Individual folders & overrides</summary><dl><dt>Database · installation path</dt><dd>/config/db</dd><dt>Thumbnails</dt><dd>/config/thumbnails</dd><dt>Backups · separate disk</dt><dd>/backups/isputnik</dd><dt>Metadata</dt><dd>/config/metadata</dd></dl></details></section>
    <section class="panel"><div class="panel-head"><i>${icon('box')}</i><div><h2>App storage</h2><p>Files created and managed by iSputnik</p></div><span class="status">On</span></div><div class="storage-summary"><div><span class="path">/config/app-storage</span><small>12.8 GB used</small></div>${btn('Change','app-location','','small')}</div><div class="storage-feature-list"><span>Photo Inbox</span><span>App files</span><span>Renders</span><span>Map data</span></div><div style="margin-top:16px">${link('View contents','contents')}</div></section></div>
    <section class="panel storage-bottom"><i>${icon('phone')}</i><div><h3>Personal library destination</h3><p><span class="path">${esc(syncSettings.folder)}</span> · One private folder per member</p></div>${link('Configure in Device Sync','device-sync/settings')}</section></div>
    <div class="below-link">${icon('info')}Locations describe where files live. Libraries describe the media you browse.</div>`;
}
const fileData = [
  {name:'Grandma’s garden.m4a',kind:'Recordings',owner:'Story · Grandma’s garden',size:'24.6 MB'},
  {name:'Summer memories.mp4',kind:'Movies',owner:'Slideshow · Summer memories',size:'428 MB'},
  {name:'Family portrait.jpg',kind:'Family tree',owner:'Person · Anna',size:'3.2 MB'},
  {name:'Piano afternoon.mp3',kind:'Music',owner:'Music library',size:'8.4 MB'},
  {name:'Old narration.m4a',kind:'Recordings',owner:null,size:'16.8 MB'}
];
function fileRows() {
  const type = document.querySelector('#contents-filter').value;
  document.querySelector('#file-rows').innerHTML = fileData.filter(f => type==='all'||(type==='orphan'&&!f.owner)||f.kind===type).map(f => `<tr><td><span class="file-name">${esc(f.name)}</span><small class="sub">${f.kind}</small></td><td class="hide-small">${f.owner?esc(f.owner):'<span class="orphan">No longer used</span>'}</td><td class="numeric">${f.size}</td><td class="numeric">${btn('Details','file',f.name,'small')}</td></tr>`).join('');
}
function contents() {
  content.innerHTML = head('App storage contents','See what app-managed files belong to, and what is taking up space.',`<a class="button" href="#storage">${icon('settings')}Storage settings</a>`) +
    `<div class="usage-grid">${[['Photo Inbox','2.4 GB','84 items waiting for review','photo',19],['App files','6.8 GB','Recordings, music & uploads','box',53],['Renders','820 MB','Slideshow work files','video',6],['Map data','2.8 GB','Offline maps & place names','map',22]].map(([name,size,note,glyph,width])=>`<div class="usage-card"><span>${icon(glyph)}${name}</span><strong>${size}</strong><div class="meter"><span style="width:${width}%"></span></div><small>${note}</small></div>`).join('')}</div>
    <div class="toolbar"><span class="label">App files</span><select id="contents-filter" aria-label="Filter app files"><option value="all">All files</option><option value="orphan">No longer used</option><option>Recordings</option><option>Music</option><option>Movies</option><option>Family tree</option></select></div>
    <div class="table-card"><table><thead><tr><th>File</th><th class="hide-small">Belongs to</th><th class="numeric">Size</th><th></th></tr></thead><tbody id="file-rows"></tbody></table><div class="table-foot">${icon('info')}This inventory covers App storage. Media libraries and private device backups are managed separately.</div></div>
    ${hint('1 file is no longer used','Review the file’s details before moving it to the Recycle Bin. Files that still belong to a story, photo or slideshow remain in place.')}`;
  fileRows(); document.querySelector('#contents-filter').addEventListener('change',fileRows);
}
const pages = {libraries,organization,'device-sync':deviceSync,storage,contents};
function route() {
  const [requested,anchor] = location.hash.slice(1).split('/');
  const page = Object.hasOwn(pages,requested) ? requested : 'libraries';
  document.querySelectorAll('[data-page]').forEach(a => {if(a.dataset.page===page)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
  pages[page]();
  document.querySelector('[aria-current="page"]')?.scrollIntoView({block:'nearest',inline:'nearest'});
  document.title = `${document.querySelector('h1').textContent} · iSputnik design preview`;
  if(anchor==='settings') document.querySelector('#sync-settings')?.scrollIntoView({behavior:'smooth',block:'start'});
  else window.scrollTo(0,0);
}
function toast(message) {
  const el = document.querySelector('#toast'); el.textContent=message; el.classList.add('visible');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('visible'),3600);
}
function openEditor(title,body,{eyebrow='DESIGN PREVIEW',save=null,label='Save preview'}={}) {
  document.querySelector('#dialog-title').textContent=title;
  document.querySelector('#dialog-eyebrow').textContent=eyebrow;
  document.querySelector('#dialog-content').innerHTML=body;
  const button=document.querySelector('#dialog-save'); button.hidden=!save; button.style.display=save?'':'none'; button.textContent=label;
  saveAction=save;
  if(!dialog.open)dialog.showModal();
}
dialog.addEventListener('close',()=>{if(dialog.returnValue==='save'&&saveAction){saveAction();toast('Updated in this preview only.');}saveAction=null;dialog.returnValue='';});
function manage(id) {
  const l=libraryData.find(x=>x.id===Number(id)); if(!l)return;
  const video=l.type.startsWith('Video'); const gallery=l.type==='Gallery';
  openEditor(l.name,`<p>${l.type} library · Settings relevant to this media type.</p>${field('Library name','edit-library-name',l.name)}<div class="dialog-grid"><label class="field">Who can use this library<select id="edit-access"><option ${l.access==='Family'?'selected':''}>Family</option><option ${l.access==='Adults'?'selected':''}>Adults</option><option ${l.access==='Private'?'selected':''}>Private</option></select></label>${field('Folder','edit-folder',l.folder)}</div>
    <section class="dialog-section"><h3>Scanning</h3><p>Read metadata and find new files in this library.</p><label class="check-row"><input type="checkbox" checked>Include this library in scheduled scans</label></section>
    ${gallery?'<section class="dialog-section"><h3>Photo settings</h3><p>Face recognition, scanned print pairing, and links to device backups.</p><label class="check-row"><input type="checkbox" checked>Recognize faces in this library</label><label class="check-row"><input type="checkbox">Match existing photos with linked devices</label></section>':''}
    <section class="dialog-section"><h3>Organization</h3><p>${video?'Movies and shows use the shared Video genres set.':gallery?'Gallery items use the shared Tags set.':'Ebooks and audiobooks share Book categories and Tags.'}</p>${btn(video?'Manage video genres':gallery?'Manage tags':'Manage book categories','organize',video?'genres':gallery?'tags':'categories','small','arrow')}</section>`,
    {eyebrow:'LIBRARIES / MANAGE',save:()=>{l.name=document.querySelector('#edit-library-name').value.trim()||l.name;l.access=document.querySelector('#edit-access').value;l.folder=document.querySelector('#edit-folder').value;route();}});
}
const actions={
  manage,
  'add-library':()=>openEditor('Add a library',`<p>Choose the media type first. Only the settings that apply to it will appear.</p>${field('Library name','new-name','')}<label class="field">Media type<select id="new-type"><option>Gallery</option><option>Audiobooks</option><option>Ebooks</option><option>Video · Movies</option></select></label>${field('Folder inside a library location','new-folder','/media/')}`,{eyebrow:'LIBRARIES / ADD',label:'Add to preview',save:()=>{const type=document.querySelector('#new-type').value;libraryData.push({id:Date.now(),name:document.querySelector('#new-name').value.trim()||'New library',type,icon:type==='Gallery'?'photo':type==='Audiobooks'?'audio':type==='Ebooks'?'book':'video',tone:'',size:'0 GB',items:'Awaiting first scan',access:'Family',status:'Awaiting scan',folder:document.querySelector('#new-folder').value});route();}}),
  actions:id=>{const l=libraryData.find(x=>x.id===Number(id));openEditor(`${l.name} actions`,`<p>Less frequent actions live here, keeping the library list easy to scan.</p><div class="settings-list"><div class="setting-row"><div><strong>Scan for changes</strong><small>Look for new or changed files in this library.</small></div>${btn('Scan','scan',id,'small','refresh')}</div><div class="setting-row"><div><strong>Delete library</strong><small>Remove its catalog. Original files remain on disk.</small></div>${btn('Review','delete-library',id,'small')}</div></div>`);},
  scan:id=>{dialog.close();toast('Preview: the scan would appear in Maintenance → Tasks.');},
  'delete-library':id=>{const l=libraryData.find(x=>x.id===Number(id));openEditor(`Delete “${l.name}”?`,'<p>This preview illustrates the confirmation step. In the app, removing a library removes its catalog; original files stay on disk.</p>',{label:'Remove from preview',save:()=>{libraryData.splice(libraryData.indexOf(l),1);route();}});},
  organize:key=>{const titles={categories:'Book categories',tags:'Tags',genres:'Video genres'};const scopes={categories:'Shared by all ebook and audiobook libraries.',tags:'Shared across books, Gallery, stories, albums, slideshows and people.',genres:'Shared by movie and TV show libraries.'};openEditor(titles[key],`<p>${scopes[key]} Example entries are shown below.</p><ul class="dialog-list">${orgData[key].map(([name,count])=>`<li><strong>${esc(name)}</strong><small>${count}</small></li>`).join('')}</ul><section class="dialog-section">${field('Add an example entry','new-org-name','')}</section>`,{eyebrow:'ORGANIZATION / '+titles[key].toUpperCase(),label:'Add to preview',save:()=>{const name=document.querySelector('#new-org-name').value.trim();if(name)orgData[key].push([name,'0 uses']);}});},
  'sync-guide':()=>openEditor('Set up Device Sync',`<p>Three steps to get your household ready.</p><ul class="dialog-list"><li><span><strong>1. Allow personal libraries</strong><small class="sub">Choose members, destination and size limits.</small></span>${icon('check')}</li><li><span><strong>2. Configure network access</strong><small class="sub">List allowed networks and the server address.</small></span>${icon('check')}</li><li><span><strong>3. Members connect their devices</strong><small class="sub">Profile → My library → Add a device.</small></span>${icon('phone')}</li></ul>${hint('Private by design','Administrators can check device status and storage use, but cannot browse another member’s personal library.')}`,{eyebrow:'DEVICE SYNC / GET STARTED'}),
  device:id=>{const d=devices[Number(id)];openEditor(d.name,`<p>Registered to ${d.owner}. This view shows connection information only.</p><ul class="dialog-list"><li><span>Last contact</span><strong>${d.contact}</strong></li><li><span>Network</span><strong>${d.network}</strong></li><li><span>Status</span><span class="status ${d.warn?'warning':''}">${d.state}</span></li></ul>${d.warn?hint('Check the device’s connection','Open the backup app on the device and check that it is connected to an allowed network.'):hint('Connected','No connection problems have been reported. File names and media counts remain private.')}<section class="dialog-section"><h3>History</h3><p>In the app, this opens Logs filtered to this device.</p>${btn('View sample history','device-log',id,'small','clock')}</section>`,{eyebrow:'DEVICE SYNC / DEVICE'});},
  'device-log':id=>openEditor('Device connection history',`<p>${devices[Number(id)].name} · Sample operational events.</p><ul class="dialog-list"><li><span>Device connected</span><small>Home Wi-Fi</small></li><li><span>Network allowed</span><small>Access accepted</small></li><li><span>Device registered</span><small>By its member</small></li></ul>`,{eyebrow:'DEVICE SYNC / HISTORY'}),
  'personal-settings':()=>openEditor('Personal libraries',`<p>Each member gets a private library. Set where new libraries are created and how much space each can use.</p><label class="check-row"><input type="checkbox" checked>Allow members to create a personal library</label>${field('Destination folder','sync-folder',syncSettings.folder)}<div class="dialog-grid"><label class="field">Who may have one<select id="sync-eligible"><option ${syncSettings.eligible==='Every member'?'selected':''}>Every member</option><option ${syncSettings.eligible==='Selected members'?'selected':''}>Selected members</option></select></label>${field('Size limit per member (GB)','sync-quota',syncSettings.quota,'number')}</div>${hint('Only the member can open it','Administrator access covers device status and storage size, not the photos and videos inside.')}`,{eyebrow:'DEVICE SYNC / SETTINGS',save:()=>{syncSettings.folder=document.querySelector('#sync-folder').value;syncSettings.quota=document.querySelector('#sync-quota').value;syncSettings.eligible=document.querySelector('#sync-eligible').value;route();}}),
  'network-settings':()=>openEditor('Allowed networks',`<p>Devices can back up from these networks. These rules are separate from trusted networks used for signing in.</p>${field('Home Wi-Fi','home-network','192.168.1.0/24')}${field('Home VPN','vpn-network','10.6.0.0/24')}${hint('Network access','A device outside the allowed networks is refused until it connects through home Wi-Fi or an approved VPN.')}`,{eyebrow:'DEVICE SYNC / SETTINGS',save:()=>{}}),
  'address-settings':()=>openEditor('Server address',`<p>The address members use when connecting their devices from an allowed network.</p>${field('Address','sync-address',syncSettings.address,'url')}`,{eyebrow:'DEVICE SYNC / SETTINGS',save:()=>{syncSettings.address=document.querySelector('#sync-address').value;route();}}),
  'add-location':()=>openEditor('Add library location',`<p>Approve an existing folder on the server. Libraries can use this folder or a folder inside it.</p>${field('Location name','location-name','Family archive')}${field('Server folder','location-path','/archive')}${hint('Example','Location: /archive → Library: /archive/Scanned photos')}`,{eyebrow:'STORAGE / LIBRARY LOCATIONS'}),
  'system-location':()=>openEditor('Change System data folder',`<p>In the app, moving system data starts a tracked task after the destination is checked.</p>${field('Destination','system-path','/config')}${hint('What moves','Thumbnails, backups and metadata within System data move with it. Folders with their own location stay there. The database stays at its installation path.')}`,{eyebrow:'STORAGE / SYSTEM DATA'}),
  'app-location':()=>openEditor('Change App storage folder',`<p>Choose where the app keeps its uploads and working files.</p>${field('Destination','app-path','/config/app-storage')}${hint('A tracked move','In the app, this is checked and confirmed before files move. Progress appears in Maintenance → Tasks.')}`,{eyebrow:'STORAGE / APP STORAGE'}),
  file:name=>{const f=fileData.find(x=>x.name===name);openEditor(f.name,`<ul class="dialog-list"><li><span>Folder</span><strong>${f.kind}</strong></li><li><span>Size</span><strong>${f.size}</strong></li><li><span>Belongs to</span><strong>${f.owner||'No longer used'}</strong></li></ul>${f.owner?hint('Still in use','This file is used by content in the app. Manage it from the item it belongs to.'):hint('Review before removing','This recording no longer belongs to a story. In the app, you can move an unused file to the Recycle Bin after confirming.')}`,{eyebrow:'APP STORAGE CONTENTS / FILE'});}
};
document.addEventListener('click',event=>{const el=event.target.closest('[data-action]');if(!el)return;event.preventDefault();actions[el.dataset.action]?.(el.dataset.arg);});
document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));
window.addEventListener('hashchange',route);
route();
