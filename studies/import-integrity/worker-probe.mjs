import { firefox } from 'playwright';
import { writeFile } from 'node:fs/promises';
const results=[];
for (const sendAfterTermination of [false,true]) {
 const browser=await firefox.launch(); let crash=false; let completed=0; let error;
 const page=await browser.newPage();page.on('crash',()=>{crash=true;});
 await page.setContent('<input type="file" id="file">');
 try {
 for(let i=0;i<100;i++) {
  await page.locator('#file').setInputFiles({name:`data-${i}.json`,mimeType:'application/json',buffer:Buffer.from('{"value":"controlled worker probe"}')});
  await page.evaluate(send=>{const worker=new Worker(URL.createObjectURL(new Blob(['self.onmessage = () => {};'],{type:'text/javascript'})));worker.terminate();if(send)worker.postMessage({source:{file:document.querySelector('#file').files[0]}});},sendAfterTermination);
  completed++;
 }
 } catch(e) {error=String(e);}
 results.push({sendAfterTermination,completed,crash,error});console.log(results.at(-1));await browser.close();
}
await writeFile(process.argv[2] ?? '/tmp/tracelens-worker-probe.json',JSON.stringify(results,null,2)+'\n');
