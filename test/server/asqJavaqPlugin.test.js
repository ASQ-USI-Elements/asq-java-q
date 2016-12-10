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
      registerHook: function(){},
      registerEvent: function(){},
      db: {
        model: function(){
          return {
            create: create
          }
        }
      }
    }

    //load html fixtures
    this.simpleHtml = fs.readFileSync(require.resolve('./fixtures/simple.html'), 'utf-8');
    this.noStemHtml = fs.readFileSync(require.resolve('./fixtures/no-stem.html'), 'utf-8');
    //this.optionsHtml = fs.readFileSync(require.resolve('./fixtures/options.html'), 'utf-8');

    this.asqJavaqPlugin = require(modulePath);
  });

  describe("parseHtml", function(){

    before(function(){
     sinon.stub(this.asqJavaqPlugin.prototype, "processEl").returns(Promise.resolve("res"));
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
        html: this.simpleHtml
      })
      .then(function(){
        this.asqJavaq.processEl.calledTwice.should.equal(true);
        done();
      }.bind(this))
      .catch(function(err){
        done(err)
      })
    });

    it("should call `model().create()` to persist parsed questions in the db", function(done){
      this.asqJavaq.parseHtml({
        html: this.simpleHtml
      })
      .then(function(result){
        this.create.calledOnce.should.equal(true);
        this.create.calledWith(["res", "res"]).should.equal(true);
        done();
      }.bind(this))
      .catch(function(err){
        done(err)
      })
    });

    it("should resolve with the file's html", function(done){
      this.asqJavaq.parseHtml({
        html: this.simpleHtml
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
      var el = $(this.tagName)[0];
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
      var el = $(this.tagName)[0];
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
      var el = $(this.tagName)[1];

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


});
