// Launch AutoDoc's compiled, unmodified desktop main process. No IPC overrides.
const {app,BrowserWindow}=require('electron');
const path=require('node:path');
process.env.AUTODOC_TEST_MODE='1';
process.env.AUTODOC_TEST_REAL_SETUP='1';
process.env.AUTODOC_E2E='0';
process.env.AUTODOC_TEST_USER_DATA_DIR='/private/tmp/autodoc-real-footage-profile';
process.env.AUTODOC_SKIP_INSTALL_POLICY='1';
process.env.NODE_ENV='test';
app.on('browser-window-created',(_,win)=>{
 win.webContents.once('did-finish-load',()=>{
  if(win.webContents.getURL().includes('/out/renderer/')){
   win.setContentSize(1280,800);win.center();
   console.log('REAL_AUTODOC_WINDOW',win.id,JSON.stringify(win.getBounds()));
  }
 });
});
require(path.resolve(__dirname,'../../../out/main/index.js'));
