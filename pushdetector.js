// pushdetector.js Copyright 2017 Paul Beaudet ~ License MIT
var path = require('path');
var tmp = require('tmp');
var FIVE_MIN = 300000; // milliseconds in five minutes
var ONE_MIN = 60000;   // one minute to milliseconds
var APP_TITLE = 'Hangoutwithme';

var firebase = { // it might be better to set this up in a suplemantery service that regularly checks when notifications need to be sent
    admin: require('firebase-admin'),
    init: function(serviceFilePath){
        var serviceAccount = require(serviceFilePath);
        firebase.admin.initializeApp({
            credential: firebase.admin.credential.cert(serviceAccount)
        });
    },
    pushIt: function(fcmToken, msg, link, onPush){
        var payload = {data: {title: APP_TITLE, body: msg, click_action: link}};
        firebase.admin.messaging().sendToDevice(fcmToken, payload).then(function(response) {
            // console.log("Successfully sent message:", response);
            if(onPush){onPush(null, response);} // given we respond to succesful pushes respond with error and succesful response
        }).catch(function(error) {
            console.log("pushdetector send error:", JSON.stringify(error));
            if(onPush){onPush(error);}
        });
    },
    pushEm: function(fcmTokens, msg, link, allPushingDone){
        return function doThePushing(){
            firebase.pushIt(fcmTokens[fcmTokens.length - 1], msg, link, function onPush(error, res){
                if(error){
                    allPushingDone(error);// abort, TODO can created retry logic later
                } else if(res){           // because fuck reading what that thing has to say, lets just assume things
                    fcmTokens.pop();      // pop off that one we just sent to recursively hit the next in array
                    if(fcmTokens.length){ // basecase: as long as we still have tokens to push to
                        firebase.pushEm(fcmTokens, msg, link, allPushingDone)();
                    } else {allPushingDone();}
                }
            });
        };
    }
};

var mongo = {
    MAIN: 'hangoutwithme', // name of key to call database by
    PUSH: 'pushdetector',  // name of push server database
    LOBBY: 'lobbys',       // name of collection that stores customer routes
    USER: 'profiles',      // name of collection that stores user data
    LOGIN: 'logins',       // persitent key/val store of lOGIN users (should prob use redis)
    STATUS: 'status',      // stores appointment status
    APPOINTMENT: "appointments", // collection that stores appointments
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
        mongo.db[mongo.PUSH].collection('logs').insertOne({ // its important this is database that this service is pointed at
                msg: msg,
                timestamp: timestamp.toUTCString()
            }, function onInsert(error){
            if(error){
                console.log('Mongo Log error: ' + error);
                console.log(msg);
            }
        });
    },
    init: function(PUSH_DB_URL, MAIN_DB_URL, dbsUp){
        mongo.connect(MAIN_DB_URL, mongo.MAIN, function mainConnected(){        // connect to main database
            mongo.connect(PUSH_DB_URL, mongo.PUSH, function pushDBconnected(){  // connect to push database
                dbsUp();
            });
        });
    }
};

var detect = {
    appointments: function(){
        setTimeout(detect.appointments, 60000);  // call this function once more in x millis of time
        detect.startTime = new Date().getTime(); // place hold starting time to understand if event is taking too long to process
        var cursor = mongo.db[mongo.MAIN].collection(mongo.APPOINTMENT).find({time: {$gte : detect.startTime}}); // query web app database
        detect.doc(cursor);                      // we only care about appointments that could possibly happen
    },
    doc: function(cursor){
        process.nextTick(function nextDoc(){                                        // free event loop to tackle things like sending notifications
            cursor.nextObject(function onDoc(error, appointment){                   // read current object being pointed at, pointer is incremented at end
                if(error){mongo.log('headsup: ' + error);}                          // just in case, we may want to continue to recurse in this case
                else if(appointment){                                               // given that we have a document for this place cursor points to
                    mongo.db[mongo.PUSH].collection(mongo.STATUS).findOne(          // finds recorded status of notification opperations
                        {lobbyname: appointment.lobbyname, time: appointment.time}, // appointments are only unique object.id or lobbyname and time
                        function onStatus(err, status){                             // note we could find something or nothing and its fine either way
                            if(err){mongo.log('error finding status: ' + error);}   // NOTE: might want to detect.process whether there was an error or not
                            else{detect.process(appointment, status);}              // appointment stays in closure, status could be undefined
                        }                                                           // NOTE this is an async for inside a for as far on two seperate dbs
                    );                                                              // May pull all appointments in to mem before any status are found
                    detect.doc(cursor);                                             // recurse through entire collection when all is good
                } else {                                                            // else when we have run out of items in stream
                    var elapsed = new Date().getTime() - detect.startTime;          // note how long it took to process all documents, will change with growth
                    console.log('done stream in: ' + elapsed + ' milliseconds');    // log this for now maybe record it future
                }
            });
        });
    },
    process: function(appointment, status){   // checks data state against our recorded status
        var pending = {
            lobbyname: appointment.lobbyname, // not needed for updates, but helps to be able to easily pass it
            time: appointment.time,           // makes this doc easy to find lobby plus time will always be uniques because there is no double booking
            proccessBlock: false,             // basically means a current process waiting for a result
            notified: false,                  // lobby owner got notified this interaction is going to happen
            confirmed: false,                 // lobby owner confirmed appointment
            initiated: false,                 // appointment has been initiated
            attempts: 0,                      // notification attempts (broad any failure)
        };
        if(status){                           // given we have established status or defualts
            if(status.proccessBlock){return;} // this appointment has pending opperations with another process, move to next doc
            if(status.notified){pending.notified = true;}
            if(status.confirmed){pending.confirmed = true;}
            if(status.initiated){pending.initiated = true;}
            if(status.attempts){pending.attempts = status.attempts;}
        }
        var offset = pending.time - new Date().getTime();          // figure in how many millis appointment needs to happen
        if(offset < FIVE_MIN){                                     // given that this appointment is comming up in about five minutes
            if(!pending.initiated){
                detect.getUser(pending, function(profile){
                    var particpants = [profile.fcmToken, appointment.fcmToken];
                    offset = pending.time - new Date().getTime();  // recalculated offset of when to send because this is async
                    setTimeout(firebase.pushEm(particpants, 'hangout starting', profile.hangoutLink, detect.onInitiate(pending)), offset); //
                });
                pending.proccessBlock = true;
            }
        } else {
            if(!pending.notified){ // check if user has been notified already
                detect.getUser(pending, function(profile){
                    firebase.pushIt(profile.fcmToken, 'someone made an appointment with you', '/user/' + profile.lobbyname, detect.onNotify(pending));
                });
                pending.proccessBlock = true;
            }
        }
        detect.update(pending); // note this should execute before callbacks with follow up updates are executed
    },
    getUser: function(pending, onProfile){ // middleware for keeping status up to date while intiating and appointment
        mongo.db[mongo.MAIN].collection(mongo.USER).findOne(
            {lobbyname: pending.lobbyname},
            function onInfo(error, profile){
                if(profile){onProfile(profile);}
                else {
                    pending.proccessBlock = false;
                    detect.update(pending);
                }
            }
        );
    },
    onInitiate: function(previousPending){
        var pending = {
            lobbyname: previousPending.lobbyname,
            time: previousPending.time,
        };
        return function(error){
            if(error){
                pending.attempts = previousPending.attempts + 1;
                pending.proccessBlock = false;
            } else {pending.initiated = true;}
            detect.update(pending);
        };
    },
    onNotify: function(previousPending){
        var pending = {
            lobbyname: previousPending.lobbyname,
            time: previousPending.time,
        };
        return function(error){
            if(error){pending.attempts = previousPending.attempts + 1;
            } else   {pending.notified = true;}
            pending.proccessBlock = false;
            detect.update(pending);
        };
    },
    update: function(pending){                                   // update push notification database that tracks status of pending appointments
        mongo.db[mongo.PUSH].collection(mongo.STATUS).updateOne(
            {lobbyname: pending.lobbyname, time: pending.time},  // search object, lobby and time combined are unique
            {$set: pending},                                     // update object, will set new feilds with out completly replacing doc
            {upsert: true},                                      // create an new docment from search object and update object when no doc is found
            function statusUpdate(err, res){                     // callback on succesful update
                if(err){mongo.log('status update error: '+ error);}
            }
        );
    }
};

var clean = { // methods that removes or archives inactive documents from database this process is responsible for
    status: function(){
        mongo.db[mongo.PUSH].collection(mongo.STATUS).deleteMany({time: {$lte : new Date().getTime() - 20}}, function onDeleted(error, result){ // TODO subtract buffer time
            if(error){console.log('deleteMany error: ' + error);}
            else{console.log(result.result.n + " doc(s) deleted");}
        });
        setTimeout(clean.status, 60000);
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

function startup(serviceFilePath){
    firebase.init(serviceFilePath);                       // setup communication with firebase servers to do push notifications
    mongo.init(process.env.MONGODB_URI, process.env.MAIN_MONGO, function mainDbUp(){ // set up connections for data persistence
        detect.appointments();                           // Streams through appointments and updates status and send push notifications when needed
        clean.status();                                  // Streams through status and removes or archives old stuff
    });
}

if(process.env.NEW_CONFIG === 'true'){        // given that this is on dev side and a new service account is added
    config.encrypt(process.env.KEY, startup); // lock up service account file for firebase on dev machine
} else {                                      // mainly exist so that heroku can atomatically pull changes to repo
    config.decrypt(process.env.KEY, startup); // decrypt service Account file when in the cloud (given shared key has been set)
}
console.log('Starting pushdetector version ' + require('./package.json').version); // show version of package when restarted
