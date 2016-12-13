var ASQPlugin = require('asq-plugin');
var Promise = require('bluebird');
var coroutine = Promise.coroutine;
var cheerio = require('cheerio');
var mongoose = require('mongoose');
var ObjectId = mongoose.Types.ObjectId;
var assert = require('assert');
var _ = require('lodash');
var net = require('net');

const JsonSocket = require('json-socket');
const fs = require('fs');

const redis = require('redis');
Promise.promisifyAll(redis.RedisClient.prototype);
const client = redis.createClient();


// Settings
const MAXTIME = 10000; // ms to prefent spam of running
const TIMELIMITCOMPILE = 10000 // ms before get timout compilation
const TIMELIMITEXECUTION = 10000 // ms before get timout execution


//http://www.w3.org/html/wg/drafts/html/master/infrastructure.html#boolean-attributes
function getBooleanValOfBooleanAttr(attrName, attrValue){
  if(attrValue === '' || attrValue === attrName){
    return true;
  }
  return false;
}

module.exports = ASQPlugin.extend({
  tagName : 'asq-java-q',

  hooks:{
    "parse_html"          : "parseHtml",
    "answer_submission"   : "answerSubmission",
    "presenter_connected" : "presenterConnected",
    "viewer_connected"    : "viewerConnected"
  },

  events: {
   "plugin": "onPlugin"
  },

  _dashed2Camel: function(attr) {
    var l_attr = _.clone(attr);
    Object.keys(l_attr).forEach(function(key, index){
      if ( key.indexOf('-') >= 0 ) {
        var value = l_attr[key];
        delete l_attr[key];
        var camelCased = key.replace(/-([a-z])/g, function (g) {
          return g[1].toUpperCase();
        });
        l_attr[camelCased] = value;
      }
    });
    return l_attr;
  },

  _camel2dashed: function(attr) {
    var l_attr = _.clone(attr);
    Object.keys(l_attr).forEach(function(key, index){
      var value = l_attr[key];
      delete l_attr[key];
      var dashed = key.replace(/([A-Z])/g, function($1){
        return "-"+$1.toLowerCase()
      });
      l_attr[dashed] = value;
    });
    return l_attr
  },


  parseHtml: coroutine(function* parseHtmlGen(options){
    var $ = cheerio.load(options.html,  {
      decodeEntities: false,
      lowerCaseAttributeNames:false,
      lowerCaseTags:false,
      recognizeSelfClosing: true
    });
    var javaQuestions = [];

    var all = $(this.tagName).toArray();
    for ( var i in all) {
      var el = all[i];
      var question = yield this.processEl($, el);

      // files.json
      const fileJson = JSON.parse(yield this.getFiles(options.slideshow_id.toString(), question.data.exerciseName, 'files.json'));
      question.data.files = {
        main: fileJson.main,
        files: []
      }
      //getting files
      for(let fileName of fileJson.files){
        const fileContent = yield this.getFiles(options.slideshow_id.toString(), question.data.exerciseName, fileName);
        question.data.files.files.push({
          name: fileName,
          data: fileContent
        });
      }


      javaQuestions.push(question);
    }

    options.html = $.root().html();
    //return Promise that resolves with the (maybe modified) html
    return this.asq.db.model("Question").create(javaQuestions)
    .then(function(){

      return Promise.resolve(options);
    });

  }),


  getFiles: function(slideId, exerciseName, fileName){
    const exerciseFolder = __dirname + "/../../../slides/" + slideId + "/files/" + exerciseName + '/';
    return new Promise ((resolve, reject)=>{
      fs.readFile(exerciseFolder + fileName, 'utf8', (err, data)=>{
          if (err) reject(err);
          else resolve(data);
      })
    })
  },


  restorePresenterForSession: coroutine(function *restorePresenterForSessionGen(session_id, presentation_id){

    var questions = yield this.asq.db.getPresentationQuestionsByType(presentation_id, this.tagName);
    var questionIds = questions.map(function(q){
      return q._id;
    });

    var pipeline = [
      { $match: {
          session: session_id,
          "question" : {$in : questionIds}
        }
      },
      { $sort:{"submitDate": -1}},
      { $group:{
          "_id":{
            "answeree" : "$answeree",
            "question" : "$question"
          },
          "submitDate":{$first:"$submitDate"},
          "submission": {$first:"$submission"},
        }
      },
      { $group:{
          "_id": {
            "question" : "$_id.question",
          },
          "submissions": {$push: {
            "_id" : "$_id.answeree" ,
            "submitDate": "$submitDate",
            "submission": "$submission"
          }}
        }
      },
      { $project : {
          "_id": 0,
          "question" : "$_id.question",
          "submissions" : 1
        }
      }
    ]
    var submissions = yield this.asq.db.model('Answer').aggregate(pipeline).exec();

    questions.forEach(function(q){
      q.uid = q._id.toString();
      q.submissions = [];
      for(var i=0, l=submissions.length; i<l; i++){
        if(submissions[i].question.toString() == q._id){
          q.answers = submissions[i].submissions
          break;
        }
      }
    });

    return questions;
  }),


  countAnswers : coroutine(function *countAnswersGen(session_id, presentation_id){
    var questions = yield this.asq.db.getPresentationQuestionsByType(presentation_id, this.tagName);
    var questionIds = questions.map(function(q){
      return q._id;
    });
    var pipeline = [
      { $match: {
          "session": session_id,
          "question" : {$in : questionIds}
        }
      },
      { $sort:{"submitDate": -1}},
      { $group:{
          "_id":{
            "answeree" : "$answeree",
            "question" : "$question"
          },
          "submitDate":{$first:"$submitDate"},
          "submission": {$first:"$submission"},
        }
      },
      { $group: { _id: null, count: { $sum: 1 } } },
      { $project : {
          "_id": 0,
          "count" : 1
        }
      }
    ]

    var total = yield this.asq.db.model('Answer').aggregate(pipeline).exec();

    var count = 0;
    if ( total.length ) {
      count = total[0].count;
    }

    return count;
  }),

  presenterConnected: coroutine(function *presenterConnectedGen (info){

    if(! info.session_id) return info;

    var questionsWithScores = yield this.restorePresenterForSession(info.session_id, info.presentation_id);

    var total = 0;

    if(questionsWithScores.length){
      total = yield this.countAnswers(info.session_id, info.presentation_id);
    }

    var event = {
      questionType: this.tagName,
      type: 'restorePresenter',
      questions: questionsWithScores,
      total:total
    }

    this.asq.socket.emit('asq:question_type', event, info.socketId)

    //this will be the argument to the next hook
    return info;
  }),

  restoreViewerForSession: coroutine(function *restoreViewerForSessionGen(session_id, presentation_id, whitelistId){

    var questions = yield this.asq.db.getPresentationQuestionsByType(presentation_id, this.tagName);
    var questionIds = questions.map(function(q){
      return q._id;
    });

    var pipeline = [
      { $match: {
          "session": session_id,
          "answeree" : whitelistId,
          "question" : {$in : questionIds}
        }
      },
      { $sort:{"submitDate": -1} },
      { $group:{
          "_id": "$question",
          "submission": {$first:"$submission"},
        }
      },
      { $project:{
          "_id": 0,
          "uid" : "$_id",
          "submission": 1,
        }
      }

    ]
    var questionsWithAnswers = yield this.asq.db.model('Answer').aggregate(pipeline).exec();

    return questionsWithAnswers;
  }),

  viewerConnected: coroutine(function *viewerConnectedGen (info){

    if(! info.session_id) return info;

    var questionsWithAnswers = yield this.restoreViewerForSession(info.session_id, info.presentation_id, info.whitelistId);
    var event = {
      questionType: this.tagName,
      type: 'restoreViewer',
      questions: questionsWithAnswers
    }

    this.asq.socket.emit('asq:question_type', event, info.socketId)
    // this will be the argument to the next hook
    return info;
  }),

  answerSubmission: coroutine(function *answerSubmissionGen (answer){
    // make sure answer question exists
    var questionUid = answer.questionUid
    var question = yield this.asq.db.model("Question").findById(questionUid).exec();
    assert(question,
      'Could not find question with id' + questionUid + 'in the database');

    //make sure it's an answer for an asq-java-q question
    if(question.type !== this.tagName) {
      return answer;
    }

    assert(_.isObject(answer.submission),
      'Invalid answer format, answer.submission should be a string.');

    // {compileTimeoutMs, executionTimeoutMs, spamTimeoutMs, charactersMaxLength}
    let options = {};
    const permittedOptions = ['compileTimeoutMs', 'executionTimeoutMs', 'spamTimeoutMs', 'charactersMaxLength']
    for(let opt of question.settings){
      if(permittedOptions.indexOf(opt.key) > -1)
        options[opt.key] = opt.value;
    }

    const result = yield this.getResultFromServer(answer.submission, answer.socketId, options);

    delete result["clientId"];
    result["questionUid"] = questionUid;

    const evtResponse = {
      type : "output",
      questionType : this.tagName,
      data : result
    }

    this.asq.socket.emit('asq:question_type', evtResponse, answer.socketId);


    answer.submission = {
      compile : result.passed,
      output: result.output,
      error: result.errorMessage,
      submission : answer.submission
    }

    //persist
    yield this.asq.db.model("Answer").create({
      exercise   : answer.exercise_id,
      question   : questionUid,
      answeree   : answer.answeree,
      session    : answer.session,
      type       : question.type,
      submitDate : Date.now(),
      submission : answer.submission,
      confidence : answer.confidence
    });

    this.calculateProgress(answer.session, ObjectId(questionUid));

    //this will be the argument to the next hook
    return answer;
  }),


  runCodeSocket: coroutine(function *runCodeSocketGen(evt){

    var question = yield this.asq.db.model("Question").findById(evt.data.questionUid).exec();

    let options = {};
    const permittedOptions = ['compileTimeoutMs', 'executionTimeoutMs', 'spamTimeoutMs', 'charactersMaxLength']
    for(let opt of question.settings){
      if(permittedOptions.indexOf(opt.key) > -1)
        options[opt.key] = opt.value;
    }

    this.sendCodeToJavabox(evt.data.submission, evt.socketId, options, function(result){
      delete result["clientId"];
      result["questionUid"] = evt.data.questionUid;

      const evtResponse = {
        type : "output",
        questionType : this.tagName,
        data : result
      }

      this.asq.socket.emit('asq:question_type', evtResponse, evt.socketId);

    }.bind(this))
  }),


  getFilesSocket: coroutine(function *getFilesSocketGen(evt){
    const questionUid = evt.data.questionUid;
    const question = yield this.asq.db.model("Question").findById(questionUid).exec();
    assert(question,
      'Could not find question with id' + questionUid + 'in the database');

    //make sure it's an answer for an asq-java-q question
    if(question.type !== this.tagName) {
      return;
    }

    const evtResponse = {
      type : "getFiles",
      questionType : this.tagName,
      questionUid: questionUid,
      data : question.data.files
    }

    this.asq.socket.emit('asq:question_type', evtResponse, evt.socketId);

  }),


  onPlugin: function onPlugin (evt){
    if(evt.type !== 'asq-java-q') return;

    if(evt.data.type == 'run'){
      this.runCodeSocket(evt);
    }else if(evt.data.type == 'getFiles'){
      this.getFilesSocket(evt);
    }
  },

  calculateProgress: coroutine(function *calculateProgressGen(session_id, question_id){
    var criteria = {session: session_id, question:question_id};
    var pipeline = [
      { $match: {
          session: session_id,
          question : question_id
        }
      },
      {$sort:{"submitDate":-1}},
      { $group:{
          "_id":"$answeree",
          "submitDate":{$first:"$submitDate"},
          "submission": {$first:"$submission"},
        }
      }
    ]

    var answers = yield this.asq.db.model('Answer').aggregate(pipeline).exec();
    var event = {
      questionType: this.tagName,
      type: 'progress',
      question: {
        uid: question_id.toString(),
        answers: answers,
      }
    }

    this.asq.socket.emitToRoles('asq:question_type', event, session_id.toString(), 'ctrl')
  }),


  /* tests
    1) with no attributes for initial settings, default settings should be persisted to the db
    2) with no attributes for initial settings, default settings should be serialied back to the element
    3) If the element has attrribute that overrides default, should be persisted to the db
    4) If the element has attrribute that overrides default, this attribute  should maintain its value
  */
  parseSettings: coroutine(function* parseSettingsGen($, el) {
    const $el = $(el);
    const attrs = this._dashed2Camel($el.attr());

    const defaultSettings = this.asq.api.settings.defaultSettings['question'];

    const defaultQuestionSettings = [
      {
        "key": "compileTimeoutMs",
        "value": "10000",
        "kind": "number",
        "level": "question"
      },
      {
        "key": "executionTimeoutMs",
        "value": "10000",
        "kind": "number",
        "level": "question"
      },
      {
        "key": "spamTimeoutMs",
        "value": "1000",
        "kind": "number",
        "level": "question"
      },
      {
        "key": "charactersMaxLength",
        "value": "10000",
        "kind": "number",
        "level": "question"
      },
    ]

    // merge with default with question settings
    const settings = [...defaultSettings, ...defaultQuestionSettings];

    // if there's an attribute for a setting in the element
    // it wins
    for ( var i in settings ) {
      if ( attrs.hasOwnProperty(settings[i].key) ) {
        // validation ?
        settings[i].value = attrs[settings[i].key];
      }
    }

    // write settings back to element
    // first convert to dictionary
    const attrSettings = {};
    settings.forEach((s)=>{
      attrSettings[s.key] = s.value
    })

    // then convert to dashed attrs and write
    var l_settings = (this._camel2dashed(attrSettings));
    $el.attr(l_settings);

    return settings
  }),

  writeSettingAsAttribute: function($el, setting) {
    // boolean
    $el.attr(setting.key, setting.value);
  },

  processEl: coroutine(function* processElGen($, el){

    var $el = $(el);

    //make sure question has a unique id
    var uid = $el.attr('uid');
    if(uid == undefined || uid.trim() == ''){
      $el.attr('uid', uid = ObjectId().toString() );
    }

    //get stem
    var stem = $el.find('asq-stem');
    if(stem.length){
      stem = stem.eq(0).html();
    }else{
      stem = '';
    }

    var settings = yield this.parseSettings($, el);

    //get files
    const exerciseName = $el.attr('exercise-name');


    return {
      _id : uid,
      type: this.tagName,
      data: {
        html: $.html($el),
        stem: stem,
        exerciseName: exerciseName,
      },
      settings: settings
    }

  }),

  antiSpamFilter: coroutine(function *antiSpamFilterGen(socketId){
    const userId = 'asq-java-q-anti-spam-' + socketId;

    const userAntiSpam = parseInt(yield this.redisGet(userId));

    if(!userAntiSpam){
      client.setex(userId, 3600, Date.now());
      return false;
    }

    if(userAntiSpam + MAXTIME > Date.now()){
      // spam detected
      return true;
    }

    client.setex(userId, 3600, Date.now());
    return false;
  }),

  redisGet: function(userId){
    return new Promise ((resolve, reject)=>{
      client.get(userId, (err, data)=>{
          if (err) reject(err);
          else resolve(data);
      })
    })
  },

  sendCodeToJavabox: coroutine(function* sendCodeToJavaboxGen(submission, clientId, options, cb){

    if(yield this.antiSpamFilter(clientId)) return;
    // options : {compileTimeoutMs, executionTimeoutMs, spamTimeoutMs, charactersMaxLength}

    /**
     * Contains the files data
     * Structure example:
     * {
     *   clientId : "1234",
     *   submission : {
     *     main: 'Main.java',
     *     files: [
     *       {
     *         name: "class1.java",
     *         data: "void hello(){}"
     *       },
     *       {
     *         name: "Main.java",
     *         data: "void main(String[] args){}"
     *       }
     *     ]
     *   },
     *   timeLimitCompile : 200,
     *   timeLimitExecution : 200
     * }
     */

    const PORT = 5016;
    const HOST = '127.0.0.1';

    var socket = new JsonSocket(new net.Socket());
    socket.connect(PORT, HOST);

    socket.on('connect', function() {

      var sendObj = {
        clientId,
        submission,
        timeLimitCompile : TIMELIMITCOMPILE,
        timeLimitExecution : TIMELIMITEXECUTION
      }
      socket.sendMessage(sendObj);

     /*
        format of JSON to be recieved:
        {
          "clientId",
          "passed" : {Boolean, required},
          "ouptut" : {String},
          "errorMessage" : {String},
          "timeOut" : {Boolean},
        }
      */
      socket.on('message', cb);

    });

  }),

  getResultFromServer: function (submission, clientId, options){
    return new Promise((resolve,reject)=>{
      this.sendCodeToJavabox(submission, clientId, options, function (res){
        if (res) return resolve(res);
        else return reject();
      })
    });
  }

});
