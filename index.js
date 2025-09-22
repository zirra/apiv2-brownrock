const dotenv = require('dotenv');
dotenv.config()
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.raw());
const port = process.env.PORT || 5151;

const xPolicy = (req, res, next) => {
  res.header ('Access-Control-Allow-Origin', '*')
  res.header ('Access-Control-Expose-Headers', 'ukey')
  res.header ('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.header ('Access-Control-Allow-Credentials', 'true')
  res.header ('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, token, X-CSRF-TOKEN, api-key, authorization, content-type, Bearer, ukey')
  next ()
}

app.use(xPolicy)

const loadControllers = () => {
  
  fs.readdirSync(`./controller`).forEach((file) => {
    console.log('Found file:', file)
    if(file.endsWith('.js')) {  // This is the correct way
      import(`./controller/${file}`)
        .then(obj => {
          console.log('Successfully loaded controller:', file)
          obj.controller(app)
        })
        .catch(err => console.log('Controller load error:', err))
    }
  })
  
}

loadControllers()

app.get('/health', (req,res) => {
  const formatMemoryUsage = (data) => `${Math.round(data / 1024 / 1024 * 100) / 100} MB`
  const memoryData = process.memoryUsage()
  const memoryUsage = {
    apiversion: `${process.env.VERSION}`,
    rss: `${formatMemoryUsage(memoryData.rss)} -> Resident Set Size - total memory allocated for the process execution`,
    heapTotal: `${formatMemoryUsage(memoryData.heapTotal)} -> total size of the allocated heap`,
    heapUsed: `${formatMemoryUsage(memoryData.heapUsed)} -> actual memory used during the execution`,
    external: `${formatMemoryUsage(memoryData.external)} -> V8 external memory`,
  }
  res.status(200).send(memoryUsage)
})

app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
});