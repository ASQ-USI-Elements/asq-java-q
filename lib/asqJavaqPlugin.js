var ASQPlugin = require('asq-plugin');
var Promise = require('bluebird');
var coroutine = Promise.coroutine;
var cheerio = require('cheerio');
var mongoose = require('mongoose');
var ObjectId = mongoose.Types.ObjectId;
var assert = require('assert');
var _ = require('lodash');
var net = require('net');
var JsonSocket = require('json-socket');


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
      javaQuestions.push(question);
    }

    options.html = $.root().html();
    //return Promise that resolves with the (maybe modified) html
    return this.asq.db.model("Question").create(javaQuestions)
    .then(function(){

      return Promise.resolve(options);
    });

  }),


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

    assert(_.isString(answer.submission),
      'Invalid answer format, answer.submission should be a string.');

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


    const result = yield this.getResultFromServer('Main', answer.submission, answer.socketId);

    delete result["clientId"];
    result["questionUid"] = questionUid;

    const evtResponse = {
      type : "output",
      questionType : this.tagName,
      data : result
    }

    this.asq.socket.emit('asq:question_type', evtResponse, answer.socketId);


    //this will be the argument to the next hook
    return answer;
  }),

  onPlugin: function onPlugin (evt){
    if(evt.type !== 'asq-java-q') return;


    this.sendCodeToJavabox('Main', evt.data.submission, evt.socketId, function(result){
      delete result["clientId"];
      result["questionUid"] = evt.data.questionUid;

      const evtResponse = {
        type : "output",
        questionType : this.tagName,
        data : result
      }

      this.asq.socket.emit('asq:question_type', evtResponse, evt.socketId);

    }.bind(this))

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

  parseSettings: coroutine(function* parseSettingsGen($, el) {
    var $el = $(el);
    var attrs = $el.attr();

    var settings = this.asq.api.settings.defaultSettings['question'];

    for ( var i in settings ) {
      if ( attrs.hasOwnProperty(settings[i].key) ) {
        // validation ?
        settings[i].value = attrs[settings[i].key];
      }
      else {
        this.writeSettingAsAttribute($el, settings[i]);
      }
    }

    // settings = yield this.createSettings(settings);
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

    return {
      _id : uid,
      type: this.tagName,
      data: {
        html: $.html($el),
        stem: stem
      },
      settings: settings
    }

  }),

  sendCodeToJavabox(fileName, code, clientId, cb){
    // todo:
    // 1. open connection to JavaBox server through 'json-socket',
    // 2. encapsulate `code` in a json object of predifined structure
    // 3. send message and recieve response

    /*
      format of JSON to be sent:
      {
        "clientId",
        "code": {type: String, required},
        "fileName": {type: String, required},
        "timeLimit" : {type: int}
    */


    const PORT = 5000;
    const HOST = '127.0.0.1';
    const TIMELIMIT = 10000;

    var socket = new JsonSocket(new net.Socket());
    socket.connect(PORT, HOST);

    socket.on('connect', function() {

      var sendObj = {
        clientId,
        code,
        fileName,
        "timeLimit" : TIMELIMIT
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

  },

  getResultFromServer: function (fileName, code, clientId){
    return new Promise((resolve,reject)=>{
      this.sendCodeToJavabox(fileName, code, clientId, function (res){
        if (res) return resolve(res);
        else return reject();
      })
    });
  }

});
