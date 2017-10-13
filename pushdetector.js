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
    pushIt: function(fcmToken, msg, noteStatus){
        console.log(msg);
        var payload = {data: {title: APP_TITLE, body: msg, click_action: 'www.google.com'}};
        firebase.admin.messaging().sendToDevice(fcmToken, payload).then(function(response) {
            console.log("Successfully sent message:", response);
            if(noteStatus){noteStatus(null, response);}
        }).catch(function(error) {
            mongo.log("pushdetector send error:", error);
            if(noteStatus){noteStatus(error);}
        });
    },
    pushEm: function(fcmTokens, msg, allPushingDone){
        return function doThePushing(){
            firebase.pushIt(fcmTokens[fcmTokens.length - 1], msg, function(error, res){
                if(error){
                    allPushingDone(error);// abort, TODO can created retry logic later
                } else if(res){           // because fuck reading what that thing has to say, lets just assume things
                    fcmTokens.pop();      // pop off that one we just sent to recursively hit the next in array
                    if(fcmTokens.length){ // basecase: as long as we still have tokens to push to
                        firebase.pushEm(fcmTokens, msg, allPushingDone)();
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

/* var detect = { // object that is responsible for searching database to find when a push notification needs to be initiated
    appointments: function(){
        setTimeout(detect.appointments, FIVE_MIN); // call this function once more in next five minutes
        var cursor = mongo.db[mongo.MAIN].collection(mongo.USER).find({});
        detect.doc(cursor);
    },
    doc: function(cursor){
        process.nextTick(function nextDoc(){
            cursor.nextObject(function onDoc(error, doc){
                if(error){mongo.log('pushDetect' + error);}
                else if(doc){
                    detect.process(doc);
                    detect.doc(cursor);
                }
            });
        });
    },
    process: function(doc){
        if(doc.appointments.length){                                                        // if this user has any appointments
            var currentTime = new Date().getTime();                                         // this is utc and local, wrap your head around that
            for(var appointment = 0; appointment < doc.appointments.length; appointment++){ // for each appointment
                var offset = doc.appointments[appointment].time - currentTime;              // figure in how many millis appointment needs to happen
                if(offset > 0 && offset < FIVE_MIN){                           // given that this appointment is comming up in about five minutes
                    console.log('scheduling notification for appointment');
                    var millisToSend = 0;                                      // send imediately if we are getting close to send time
                    if(offset > ONE_MIN){millisToSend = offset - ONE_MIN;}     // avoid sending in a negative amount of time
                    var particpants = [doc.fcmToken, doc.appointments[appointment].fcmToken];
                    setTimeout(firebase.pushEm(particpants, doc.hangoutLink), millisToSend);
                } else {
                    if(offset > 0){console.log('skiping future appointment');}
                    else{console.log('appointment past');}
                }
            }
        }
    }
}; */

var detect = {
    appointments: function(){
        setTimeout(detector.appointments, ONE_MIN); // call this function once more in next five minutes
        detect.startTime = new Date().getTime();
        var cursor = mongo.db[mongo.MAIN].collection(mongo.APPOINTMENT).find({time: {$gte : detect.startTime}}); // TODO is there a mongo function to make comparison on database
        detector.doc(cursor); // we only care about appointments that could possibly happen
    },
    doc: function(cursor){
        process.nextTick(function nextDoc(){ // lets keep event loop free to tackle other things like sending notifications
            cursor.nextObject(function onDoc(error, appointment){
                if(error){mongo.log('headsup: ' + error);}
                else if(appointment){
                    mongo.db[mongo.PUSH].collection(mongo.STATUS).find(     // finds recorded status of notification opperations
                        {lobbyname: doc.lobbyname, time: appointment.time}, // appointments are only unique object.id or lobbyname and time
                        function onStatus(err, status){                     // note we could find something or nothing and its fine either way
                            if(err){mongo.log('error finding status: ' + error);}
                            else{detect.process(appointment, status);}
                        }
                    );
                    detect.doc(cursor);
                } else { // occures when we have fun out of items in stream
                    var endtime = new Date().getTime();
                    var elapsed = endtime - detect.startTime;
                    console.log('done stream in: ' + elapsed + ' milliseconds');
                }
            });
        });
    },
    process: function(appointment, status){                         // checks data state against our recorded status
        var pending = {
            lobbyname: appointment.lobbyname,
            time: appointment.time,
            proccessBlock: false,                              // basically means a current process waiting for a result
            lobbyOwnerNotified: false,
            confirmed: false,
            initiated: false,
            attempts: 0,                                       // notification attempts (broad)
        };
        if(status){ // given we have established status or defualts
            if(status.proccessBlock){return;} // this appointment has pending opperations with another process, move to next doc
            if(status.lobbyOwnerNotified){pending.lobbyOwnerNotified = true;}
            if(status.confirmed){pending.confirmed = true;}
            if(status.initiated){pending.initiated = true;}
        }
        var offset = pending.time - new Date().getTime();          // figure in how many millis appointment needs to happen
        if(offset < FIVE_MIN){                                     // given that this appointment is comming up in about five minutes
            if(!pending.initiated){
                detect.notify(pending, function(profile){
                    var particpants = [profile.fcmToken, appointment.fcmToken];
                    offset = pending.time - new Date().getTime();  // refigure offset to send
                    setTimeout(firebase.pushEm(particpants, profile.hangoutLink, detect.onPushes(pending)), offset); //
                });
                pendingStatus.proccessBlock = true;
            }
        } else {
            if(!pending.lobbyOwnerNotified){ // check if user has been notified already
                firebase.pushIt(appointment.fcmToken, doc.hangoutLink, detector.ownerNotified(appointment.lobbyname, appointment.time));
                pendingStatus.proccessBlock = true;
            }
        }
        detect.update(pending);
    },
    notify: function(pending, onProfile){ // middleware for keeping status up to date while intiating and appointment
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
    onPushes: function(previousPending){
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
    update: function(pending){
        mongo.db[mongo.PUSH].collection(mongo.STATUS).updateOne(
            {lobbyname: pending.lobbyname}, // search object
            {$set: pending},                // update object
            {upsert: true},                 // create an new docment from search object and update object when no doc is found
            function statusUpdate(err, res){
                if(err){mongo.log('status update error: '+ error);}
            }
        );
    }
};

var detector = { // meathods for giving lobby holders a heads up that appointments have been made
    appointments: function(){
        setTimeout(detector.appointments, ONE_MIN); // call this function once more in next five minutes
        var cursor = mongo.db[mongo.MAIN].collection(mongo.USER).find({});
        detector.doc(cursor);
    },
    doc: function(cursor){
        process.nextTick(function nextDoc(){
            cursor.nextObject(function onDoc(error, doc){
                if(error){mongo.log('headsup: ' + error);}
                else if(doc){
                    mongo.db[mongo.PUSH].collection(mongo.STATUS).find(
                        {lobbyname: doc.lobbyname},
                        function onStatus(err, status){
                            if(err){mongo.log('error finding status: ' + error);}
                            else{detector.process(doc, status);}
                        }
                    );
                    detector.doc(cursor);
                }
            });
        });
    },
    process: function(doc, currentStatus){                         // checks data state against our recorded status
        if(doc.appointments.length){                               // otherwise there is nothing to do
            var updateStatus ={appointments: [],};                 // mirrors status of appointments so main service knows when to clean up
            var stateOfStatus = {
                time: appoint.time,
                proccessBlock: false,                              // basically means a current process waiting for a result
                lobbyOwnerNotified: false,
                confirmed: false,
                initiated: false,
            };
            for(var appointment = 0; appointment < doc.appointments.length; appointment++){ // for each appointment
                var offset = doc.appointments[appointment].time - currentTime;              // figure in how many millis appointment needs to happen
                if(offset > 0 && offset < FIVE_MIN){                           // given that this appointment is comming up in about five minutes
                    status(doc.appointments[appointment], 'schedule');
                    var millisToSend = 0;                                      // send imediately if we are getting close to send time
                    if(offset > ONE_MIN){millisToSend = offset - ONE_MIN;}     // avoid sending in a negative amount of time
                    var particpants = [doc.fcmToken, doc.appointments[appointment].fcmToken];
                    setTimeout(firebase.pushEm(particpants, doc.hangoutLink), millisToSend); // TODO make sure another process hasn't already done this
                    stateOfStatus.initiated = true;
                } else {
                    if(offset > 0){
                        // TODO check if user has been notified already
                        firebase.pushIt(doc.appointments[appointment].fcmToken, doc.hangoutLink, detector.ownerNotified(doc.lobbyname, doc.appointments[appointment].time));
                        stateOfStatus.proccessBlock = true;
                    }
                }
            }
            updateStatus.appointments.push(stateOfStatus);
            mongo.db[mongo.PUSH].collection(mongo.STATUS).updateOne(
                {lobbyname: doc.lobbyname}, // search object
                {$set: updateStatus},          // update object
                {upsert: true},             // create an new docment from search object and update object when no doc is found
                function statusUpdate(err, res){
                    if(err){mongo.log('status update error: '+ error);}
                }
            );
        }
    },
    ownerNotified: function(lobby, time){
        return function(error, result){
            if(error){console.log('you probably should try to push again: ' + error);}
            else if(result){
                mongo.db[mongo.PUSH].collection(mongo.STATUS).updateOne(
                    {lobbyname: lobby, 'appointments.time': time},
                    {$set:{'appointments.$.lobbyOwnerNotified': true}},
                    function statusInsert(err, res){
                        if(err){mongo.log('status insert error: '+ error);}
                    }
                );
            } else {console.log('i dunno');}
        };
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
        detect.appointments();
    });
}

if(process.env.NEW_CONFIG === 'true'){        // given that this is on dev side and a new service account is added
    config.encrypt(process.env.KEY, startup); // lock up service account file for firebase on dev machine
} else {                                      // mainly exist so that heroku can atomatically pull changes to repo
    config.decrypt(process.env.KEY, startup); // decrypt service Account file when in the cloud (given shared key has been set)
}
