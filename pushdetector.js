// pushdetector.js Copyright 2017 Paul Beaudet ~ License MIT

var firebase = { // it might be better to set this up in a suplemantery service that regularly checks when notifications need to be sent
    admin: require('firebase-admin'),
    init: function(serviceFilePath){
        var serviceAccount = require(serviceFilePath);
        firebase.admin.initializeApp({
            credential: firebase.admin.credential.cert(serviceAccount),
            // databaseURL: dbPath // We may need this but not sure why
        });
    },
    pushIt: function(fcmToken, reminder){
        var payload = {data: {title: 'Reminder',body: reminder}};
        firebase.admin.messaging().sendToDevice(fcmToken, payload).then(function(response) {
            console.log("Successfully sent message:", response);
        }).catch(function(error) {
            console.log("Error sending message:", error);
        });
    }
};

var mongo = {
    MAIN: 'hangoutwithme', // name of key to call database by
    LOBBY: 'lobbys',       // name of collection that stores customer routes
    USER: 'profiles',      // name of collection that stores user data
    lOGIN: 'logins',       // persitent key/val store of lOGIN users (should prob use redis)
    client: require('mongodb').MongoClient,
    db: {},                                            // object that contains connected databases
    connect: function(url, dbName, connected){         // url to db and what well call this db in case we want multiple
        mongo.client.connect(url, mongo.bestCase(function onConnect(db){
            mongo.db[dbName] = db;                     // assign database object to a persistent part of this sigleton
            connected();                               // callback for things dependent on this connection
        }, function noDb(){mongo.log('could not database?');}));        // not sure why this would happen
    },
    bestCase: function(success, noResult){                              // awful abstraction layer to be lazy
        return function handleWorstCaseThings(error, wantedThing){      // this is basically the same pattern for every mongo query callback
            if(error)           {mongo.log('not best case: ' + error);} // where betting on no errors bites you but shows up in db
            else if(wantedThing){if(success){success(wantedThing);}}    // return callback and pass wanted result
            else                {if(noResult){noResult();}}             // wanted thing was missing, oh noes
        };
    },
    log: function(msg){                                // persistent logs
        var timestamp = new Date();
        mongo.db[mongo.MAIN].collection('logs').insertOne({
                msg: msg,
                timestamp: timestamp.toUTCString()
            }, function onInsert(error){
            if(error){
                console.log('Mongo Log error: ' + error);
                console.log(msg);
            }
        });
    },
    init: function(mainDbUp){
        mongo.connect(process.env.MONGODB_URI, mongo.MAIN, function connected(){                        // connect to main database
            mongo.db[mongo.MAIN].collection(mongo.LOBBY).createIndex({"lobbyname": 1}, {unique: true}); // primary unique id feild for this collection
            mainDbUp();
        });
    }
};

var config = {
    crypto: require('crypto'),
    fs: require('fs'),
    decrypt: function(key, onFinish){
        var readFile = config.fs.createReadStream(path.join(__dirname, '/config/encrypted_serviceAccount.json'));
        var decrypt = config.crypto.createDecipher('aes-256-ctr', key);
        tmp.file({prefix: 'serviceFile', postfix: '.json'},function foundTmp(error, path, fd, cleanup){
            if(error){throw error;}                            // maybe do something usefull instead
            var writeFile = config.fs.createWriteStream(path); // only place things can be writen in heroku
            readFile.pipe(decrypt).pipe(writeFile);
            writeFile.on('finish', function(){
                onFinish(path);
            }); // call next thing to do
        });
    },
    encrypt: function(key, onFinish){     // prep case for commiting encryted secrets to source
        var readFile = config.fs.createReadStream(path.join(__dirname, '/private/serviceAccount.json'));
        var encrypt = config.crypto.createCipher('aes-256-ctr', key);
        var writeFile = config.fs.createWriteStream(path.join(__dirname, '/config/encrypted_serviceAccount.json'));
        readFile.pipe(encrypt).pipe(writeFile);
        if(onFinish){
            writeFile.on('finish', function(){
                onFinish(path.join(__dirname, '/private/serviceAccount.json')); // actual location on dev machine
            });
        }
    }
};

var detect = { // object that is responsible for searching database to find when a push notification needs to be initiated
    init: function(){
        
    }
};

function startup(serviceFilePath){
    firebase.init(serviceFilePath);           // setup communication with firebase servers to do push notifications
    mongo.init(function mainDbUp(){           // set up connections for data persistence
        console.log('connected to db');
    });
}

if(process.env.NEW_CONFIG === 'true'){        // given that this is on dev side and a new service account is added
    config.encrypt(process.env.KEY, startup); // lock up service account file for firebase on dev machine
} else {                                      // mainly exist so that heroku can atomatically pull changes to repo
    config.decrypt(process.env.KEY, startup); // decrypt service Account file when in the cloud (given shared key has been set)
}
