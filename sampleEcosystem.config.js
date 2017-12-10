// install pm2 with npm install -g pm2
// pm2 is a tool to background and autostart processes. It can also keep track of logs and monitor memory usage
// This is a configuration file to run this service when your own env variables are added
// To create your own to modify that is ignored by git 'cp sampleEcosystem.config.js ecosystem.config.js'
module.exports = {                                                          // Run this config file with 'pm2 start sampleEcosystem.config.js'
  apps : [{                                                                 // this is an array that could include multiple services
    name   : "pushdetector",                                                // name that shows on using 'pm2 status'
    script : "./pushdetector.js",                                           // relitive executable assuming cofiguration is in same folder as service
    watch  : true,                                                          // service will restart when script file is changed
    env    : {
      "MAIN_MONGO": "address to database with appointments for webservice", // one can use mLab or MongoAtlas
      "MONGODB_URI": "address to database for push status",                 // this database could be run locally as well as above options
      "KEY": "key to decrypt configuration for push notifications"
    }
  }]
};
