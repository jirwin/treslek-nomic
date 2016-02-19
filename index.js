var redis = require('redis');
var sprintf = require('sprintf').sprintf;
var GitHubApi = require('github4');

var redisClient = null;
var github = null;

var NOMIC_ORG = process.env.TRESLEK_NOMIC_ORG;
var NOMIC_REPO = process.env.TRESLEK_NOMIC_REPO;
var NOMIC_USER = process.env.TRESLEK_NOMIC_USER;
var NOMIC_CHANNEL = process.env.TRESLEK_NOMIC_CHANNEL;

console.log(NOMIC_ORG);
var Nomic = function() {
  this.commands = ['players'];
  this.unload = ['endRedis'];
  this.auto = ['listen'];
  this.usage = {};
};

Nomic.prototype.endRedis = function(callback) {
  redisClient.end();
  redisClient = null;
  github = null;
  callback();
};

Nomic.prototype.players = function(bot, to, from, msg, callback) {
  var players = [NOMIC_ORG];

  function getForks(err, res) {
    if (err) {
      bot.say(to, "Error getting players.");
      callback();
      return;
    }

    players = players.concat(res.map(function (fork) {
      return fork.owner.login;
    }));

    if (github.hasNextPage(res)) {
      github.getNextPage(res, getForks);
    } else {
      bot.say(to, "The current players are: " + players.join(', '));
      callback();
    }
  }

  github.repos.getForks({
    user: NOMIC_ORG,
    repo: NOMIC_REPO,
    per_page: 100
  }, getForks);
};


Nomic.prototype.commentCreated = function(data) {
  var plusOne = /^:\+1:$|^\+1$|^-1$/,
      vote = /([\+-]1)/,
      matches = [];

  if (plusOne.test(data.comment.body)) {
    matches = data.comment.body.match(vote);
    if (!matches) {
      return;
    }

    return sprintf("%s voted %s on %s - %s", data.comment.user.login, matches[0], data.issue.title, data.issue.html_url);
  }

  return false;
};

Nomic.prototype.listen = function(bot) {
  if (!redisClient) {
    redisClient = redis.createClient(bot.redisConf.port, bot.redisConf.host);
    redisClient.auth(bot.redisConf.pass, function() {});
  }
  console.log('Loading github');
  if (!github) {
    github = new GitHubApi({
      version: "3.0.0",
      debug: true,
      protocol: "https",
      host: "api.github.com",
      pathPrefix: "",
      timeout: 5000,
      headers: {
        "user-agent": "treslek-nomic"
      }
    });
    github.authenticate({
      type: "basic",
      username: NOMIC_USER,
      password: process.env.TRESLEK_NOMIC_GITHUB_TOKEN
    });
  }
  var pattern = [bot.redisConf.prefix, 'webhookChannels:treslek-nomic'].join(':'),
      self = this;

  redisClient.on("message", function(channel, message) {
    message = message.toString();
    var data = JSON.parse(JSON.parse(message).body),
        output;

    if (data) {
      if (data.action === "created") {
        if (data.comment) {
          output = self.commentCreated(data);
        }
      } else if (data.action === "opened") {
        output = sprintf("New PR \"%s\" by %s at %s",
          data.pull_request.title, data.pull_request.user.login,
          data.pull_request.html_url, data.pull_request.body);
      } else if (data.action === "closed") {
        output = sprintf("PR %s closed by %s", data.number, data.pull_request.merged_by.login);
      }
      
      if (output) {
        bot.say(NOMIC_CHANNEL, output);
      }
    }
  });
  redisClient.subscribe(pattern);
};

exports.Plugin = Nomic;