const fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const repo=path.resolve(__dirname,'../../../..'),profile=path.join(__dirname,'test-profile-series');
const env={...process.env,NODE_ENV:'test',AUTODOC_TEST_MODE:'1',AUTODOC_E2E:'1',AUTODOC_TEST_USER_DATA_DIR:profile,AUTODOC_SKIP_INSTALL_POLICY:'1'};delete env.ELECTRON_RUN_AS_NODE;
const log=fs.openSync(path.join(__dirname,'native-app.log'),'a');
const child=spawn(path.join(repo,'node_modules/electron/dist/electron.exe'),[path.join(repo,'out/main/index.js'),'--autodoc-e2e-profile='+profile],{cwd:repo,env,stdio:['ignore',log,log],detached:true});child.unref();console.log('Isolated AutoDoc PID '+child.pid);
