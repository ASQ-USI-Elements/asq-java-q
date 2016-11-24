"use strict";

var chai = require('chai');
var sinon = require("sinon");
var should = chai.should();
var expect = chai.expect;
var cheerio = require('cheerio');
var Promise = require('bluebird');
var modulePath = "../../lib/asqMcPlugin";
var fs = require("fs");

describe("asqMcPlugin.js", function(){
  
  before(function(){
    var then =  this.then = function(cb){
      return cb();
    };

    var create = this.create = sinon.stub().returns({
      then: then
    });

    this.tagName = "asq-multi-choice-q";

    this.asq = {
      registerHook: function(){},
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
    this.optionsHtml = fs.readFileSync(require.resolve('./fixtures/options.html'), 'utf-8');
    
    this.asqMcPlugin = require(modulePath);
  });

  describe("parseHtml", function(){

    before(function(){
     sinon.stub(this.asqMcPlugin.prototype, "processEl").returns("res");
    });

    beforeEach(function(){
      this.asqmc = new this.asqMcPlugin(this.asq);
      this.asqMcPlugin.prototype.processEl.reset();
      this.create.reset();
    });

    after(function(){
     this.asqMcPlugin.prototype.processEl.restore();
    });

    it("should call processEl() for all asq-multi-choice-q elements", function(done){
      this.asqmc.parseHtml(this.simpleHtml)
      .then(function(){
        this.asqmc.processEl.calledTwice.should.equal(true);
        done();
      }.bind(this))
      .catch(function(err){
        done(err)
      })
    });

    it("should call `model().create()` to persist parsed questions in the db", function(done){
      this.asqmc.parseHtml(this.simpleHtml)
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
      this.asqmc.parseHtml(this.simpleHtml)
      .then(function(result){
        expect(result).to.equal(this.simpleHtml);
        done();
      }.bind(this))
      .catch(function(err){
        done(err)
      })
    });

  });

  describe("processEl", function(){

    before(function(){
     sinon.stub(this.asqMcPlugin.prototype, "parseOptions").returns([]);
    });

    beforeEach(function(){
      this.asqmc = new this.asqMcPlugin(this.asq);
      this.asqMcPlugin.prototype.parseOptions.reset();
    });

    after(function(){
     this.asqMcPlugin.prototype.parseOptions.restore();
    });

    it("should assign a uid to the question if there's not one", function(){
      var $ = cheerio.load(this.simpleHtml);
      
      //this doesn't have an id
      var el = $("#no-uid")[0];
      this.asqmc.processEl($, el);
      $(el).attr('uid').should.exist;
      $(el).attr('uid').should.not.equal("a-uid");

      //this already has one
      el = $("#uid")[0];
      this.asqmc.processEl($, el);
      $(el).attr('uid').should.exist;
      $(el).attr('uid').should.equal("a-uid");
    });

    it("should call parseOptions()", function(){
      var $ = cheerio.load(this.simpleHtml);
      var el = $(this.tagName)[0];

      this.asqmc.processEl($, el);
      this.asqmc.parseOptions.calledOnce.should.equal(true);
    });

    it("should find the stem if it exists", function(){
      var $ = cheerio.load(this.simpleHtml);
      var el = $(this.tagName)[0];
      var elWithHtmlInStem = $(this.tagName)[1];

      var result = this.asqmc.processEl($, el);
      expect(result.data.stem).to.equal("This is a stem");

      var result = this.asqmc.processEl($, elWithHtmlInStem);
      expect(result.data.stem).to.equal("This is a stem <em>with some HTML</em>");


      var $ = cheerio.load(this.noStemHtml);
      var el = $(this.tagName)[0];
      var result = this.asqmc.processEl($, el);
      expect(result.data.stem).to.equal("");
    });

    it("should return correct data", function(){
      var $ = cheerio.load(this.simpleHtml);
      var el = $(this.tagName)[1];

      var result = this.asqmc.processEl($, el);
      expect(result._id).to.equal("a-uid");
      expect(result.type).to.equal(this.tagName);
      expect(result.data.stem).to.equal("This is a stem <em>with some HTML</em>");
      expect(result.data.options).to.deep.equal([]);
    });
  });

  describe("parseOptions", function(){

    beforeEach(function(){
      this.$ = cheerio.load(this.optionsHtml);
      this.asqmc = new this.asqMcPlugin(this.asq);
    });

    it("should throw an error when there less than two `asq-option` tags", function(){
      var el = this.$("#no-options")[0];
      var bindedFn = this.asqmc.parseOptions.bind(this.asqmc, this.$, el);
      expect(bindedFn).to.throw(/at least two `asq-option` children/);

      el = this.$("#one-option")[0];
      bindedFn = this.asqmc.parseOptions.bind(this.asqmc, this.$, el);
      expect(bindedFn).to.throw(/at least two `asq-option` children/);
    });

    it("should assign a uid to options that don't have one", function(){
      var el;

      el = this.$("#no-uids")[0];
      this.asqmc.parseOptions(this.$, el);
      this.$(el).find('asq-option').eq(0).attr('uid').should.exist;
      this.$(el).find('asq-option').eq(1).attr('uid').should.exist;
      this.$(el).find('asq-option').eq(2).attr('uid').should.exist;

      el = this.$("#uids-ok")[0];
      this.asqmc.parseOptions(this.$, el);
      this.$(el).find('asq-option').eq(0).attr('uid').should.equal("0123456789abcd0123456781");
      this.$(el).find('asq-option').eq(1).attr('uid').should.equal("0123456789abcd0123456782");
      this.$(el).find('asq-option').eq(2).attr('uid').should.equal("0123456789abcd0123456783");
    });

    it("should throw an error when there are more than one options with the same uid", function(){
      var el = this.$("#same-uids")[0];
      var bindedFn = this.asqmc.parseOptions.bind(this.asqmc, this.$, el);
      expect(bindedFn).to.throw(/cannot have two `asq-option` elements with the same uids/);
    });

    it("should parse the `correct` attribute of options", function(){
      var el = this.$("#correct")[0];
      var result = this.asqmc.parseOptions(this.$, el);
      expect(result[0].correct).to.equal(false);
      expect(result[1].correct).to.equal(true);
      expect(result[2].correct).to.equal(true);
    });

    it("should output the correct data", function(){
      var el = this.$("#correct")[0];
      var result = this.asqmc.parseOptions(this.$, el);
      expect(result[0]._id.toString()).to.equal("0123456789abcd0123456781");
      expect(result[0].html).to.equal("Option 1");
      expect(result[0].correct).to.equal(false);
      expect(result[1]._id.toString()).to.equal("0123456789abcd0123456782");
      expect(result[1].html).to.equal("Option <em>2</em>");
      expect(result[1].correct).to.equal(true);
      expect(result[2]._id.toString()).to.equal("0123456789abcd0123456783");
      expect(result[2].html).to.equal("Option 3");
      expect(result[2].correct).to.equal(true);
    });
  });
});
