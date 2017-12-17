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
        },
    },{                               // optional continuous deployment process that responds to changes in github "npm install -g jitploy"
        name   : "cdForPushdetector", // make sure name has different first characters
        script : "./cd.sh",           // create an executable script that uses jitploy
        watch  : false,               // This will do weird things if set to true, its pointing at same directory
    }]
};

/*  example of cd.sh
 #/bin/bash
 # npm install -g jitploy
 jitploy pushdetector.js -pm2 true -repo "urfork/pushdetector" --token "urtoken" --server "urserver"
 */
