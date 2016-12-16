"use strict";

var chai = require('chai');
var sinon = require("sinon");
var should = chai.should();
var expect = chai.expect;
var cheerio = require('cheerio');
var Promise = require('bluebird');
var modulePath = "../../lib/asqJavaqPlugin";
var fs = require("fs");

describe("asqJavaqPlugin.js", function(){

  before(function(){
    var then =  this.then = function(cb){
      return cb();
    };

    var create = this.create = sinon.stub().returns({
      then: then
    });

    this.tagName = "asq-java-q";

    this.asq = {
      client : {},
      registerHook: function(){},
      registerEvent: function(){},
      db: {
        model: function(){
          return {
            create: create
          }
        }
      },
      api: {
        settings: {
          defaultSettings: {
            question: []
          }
        }
      }
    }

    //load html fixtures
    this.simpleHtml = fs.readFileSync(require.resolve('./fixtures/simple.html'), 'utf-8');
    this.noStemHtml = fs.readFileSync(require.resolve('./fixtures/no-stem.html'), 'utf-8');

    this.asqJavaqPlugin = require(modulePath);
  });

  describe("parseHtml", function(){

    before(function(){
     sinon.stub(this.asqJavaqPlugin.prototype, "processEl").returns(Promise.resolve({
      data: {exerciseName : 'ex1'}
     }));
     sinon.stub(this.asqJavaqPlugin.prototype, "getFiles").returns(Promise.resolve('{"files" : []}'));
    });

    beforeEach(function(){
      this.asqJavaq = new this.asqJavaqPlugin(this.asq);
      this.asqJavaqPlugin.prototype.processEl.reset();
      this.create.reset();
    });

    after(function(){
     this.asqJavaqPlugin.prototype.processEl.restore();
    });

    it("should call processEl() for all asq-java-q elements", function(done){
      this.asqJavaq.parseHtml({
        html: this.simpleHtml,
        slideshow_id: "0"
      })
      .then(function(){
        this.asqJavaq.processEl.calledThrice.should.equal(true);
        done();
      }.bind(this))
      .catch(function(err){
        done(err)
      })
    });

    it("should call `model().create()` to persist parsed questions in the db", function(done){
      this.asqJavaq.parseHtml({
        html: this.simpleHtml,
        slideshow_id: "0"
      })
      .then(function(result){
        this.create.calledOnce.should.equal(true);

        var expectedResult = [
          {data:{exerciseName:'ex1',files:{main: undefined, files:[], tests:[]}}},
          {data:{exerciseName:"ex1",files:{main: undefined, files:[], tests:[]}}},
          {data:{exerciseName:"ex1",files:{main: undefined, files:[], tests:[]}}}
        ]
        this.create.calledWith(sinon.match(expectedResult)).should.equal(true);
        done();
      }.bind(this))
      .catch(function(err){
        done(err)
      })
    });

    it("should resolve with the file's html", function(done){
      this.asqJavaq.parseHtml({
        html: this.simpleHtml,
        slideshow_id: "0"
      })
      .then(function(result){
        expect(result.html).to.equal(this.simpleHtml);
        done();
      }.bind(this))
      .catch(function(err){
        done(err)
      })
    });

  });

  describe("processEl", function(){

    before(function(){
     sinon.stub(this.asqJavaqPlugin.prototype, "parseSettings").returns(Promise.resolve({}));
    });

    beforeEach(function(){
      this.asqJavaq = new this.asqJavaqPlugin(this.asq);
    });

    after(function(){
     this.asqJavaqPlugin.prototype.parseSettings.restore();
    });

    it("should assign a uid to the question if there's not one", function(){
      var $ = cheerio.load(this.simpleHtml);

      //this doesn't have an id
      var el = $("#no-uid")[0];
      this.asqJavaq.processEl($, el);
      $(el).attr('uid').should.exist;
      $(el).attr('uid').should.not.equal("a-uid");

      //this already has one
      el = $("#uid")[0];
      this.asqJavaq.processEl($, el);
      $(el).attr('uid').should.exist;
      $(el).attr('uid').should.equal("a-uid");
    });


    it("should find the stem if it exists", function(done){
      var $ = cheerio.load(this.simpleHtml);
      var el = $("#no-uid")[0];
      var elWithHtmlInStem = $(this.tagName)[1];

      var result = this.asqJavaq.processEl($, el);
      result.then(function(result){
        expect(result.data.stem).to.equal("This is a stem");
      }.bind(this))
      .catch(function(err){
        done(err);
      });

      var result = this.asqJavaq.processEl($, elWithHtmlInStem);
      result.then(function(result){
        expect(result.data.stem).to.equal("This is a stem <em>with some HTML</em>");
      }.bind(this))
      .catch(function(err){
        done(err);
      });

      var $ = cheerio.load(this.noStemHtml);
      var el = $("#no-uid")[0];
      var result = this.asqJavaq.processEl($, el);
      result.then(function(result){
        expect(result.data.stem).to.equal("");
        done();
      }.bind(this))
      .catch(function(err){
        done(err);
      });
    });

    it("should return correct data", function(done){
      var $ = cheerio.load(this.simpleHtml);
      var el = $("#uid")[0];

      var result = this.asqJavaq.processEl($, el);
      result.then(function(result){
        expect(result._id).to.equal("a-uid");
        expect(result.type).to.equal(this.tagName);
        expect(result.data.stem).to.equal("This is a stem <em>with some HTML</em>");

        done();
      }.bind(this))
      .catch(function(err){
        done(err);
      });
    });
  });

  describe("parseSettings", function(){
    const defaultQuestionSettings = [
      {
        "key": "compileTimeoutMs",
        "value": "10000",
        "kind": "number",
        "level": "question"
      },
      {
        "key": "executionTimeoutMs",
        "value": "2000",
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
      {
        "key": "exerciseName",
        "value": "none",
        "kind": "string",
        "level": "question"
      },
    ]

    before(function(){
     // sinon.stub(this.asq.prototype, "parseSettings").returns(Promise.resolve({}));
    });

    beforeEach(function(){
      this.asqJavaq = new this.asqJavaqPlugin(this.asq);
    });

    it("default settings should be persisted to the db with no attributes for initial settings", function(done){
      var $ = cheerio.load(this.simpleHtml);
      var el = $("#no-uid")[0];

      var result = this.asqJavaq.parseSettings($, el);
      result.then(function(result){
        expect(result).to.deep.equal(defaultQuestionSettings);
        done();
      }.bind(this))
      .catch(function(err){
        done(err);
      });
    });

    it("default settings should be serialied back to the element with no attributes for initial settings", function(){
      var $ = cheerio.load(this.simpleHtml);
      var el = $("#no-uid")[0];

      this.asqJavaq.parseSettings($, el);
      $(el).attr('compile-timeout-ms').should.exist;
      $(el).attr('compile-timeout-ms').should.equal(defaultQuestionSettings[0].value);

      $(el).attr('execution-timeout-ms').should.exist;
      $(el).attr('execution-timeout-ms').should.equal(defaultQuestionSettings[1].value);

      $(el).attr('spam-timeout-ms').should.exist;
      $(el).attr('spam-timeout-ms').should.equal(defaultQuestionSettings[2].value);

      $(el).attr('characters-max-length').should.exist;
      $(el).attr('characters-max-length').should.equal(defaultQuestionSettings[3].value);
    });

    it("custom settings should be persisted to the db", function(done){
      var $ = cheerio.load(this.simpleHtml);
      var el = $("#settings")[0];

      var result = this.asqJavaq.parseSettings($, el);
      result.then(function(result){
        expect(result).to.deep.not.equal(defaultQuestionSettings);
        done();
      }.bind(this))
      .catch(function(err){
        done(err);
      });
    });

    it("custom settings should be serialied back to the element", function(){
      var $ = cheerio.load(this.simpleHtml);
      var el = $("#settings")[0];

      this.asqJavaq.parseSettings($, el);
      $(el).attr('compile-timeout-ms').should.exist;
      $(el).attr('compile-timeout-ms').should.not.equal(defaultQuestionSettings[0].value);

      $(el).attr('execution-timeout-ms').should.exist;
      $(el).attr('execution-timeout-ms').should.not.equal(defaultQuestionSettings[1].value);

      $(el).attr('spam-timeout-ms').should.exist;
      $(el).attr('spam-timeout-ms').should.not.equal(defaultQuestionSettings[2].value);

      $(el).attr('characters-max-length').should.exist;
      $(el).attr('characters-max-length').should.not.equal(defaultQuestionSettings[3].value);
    });

  });


});
