var path = require('path');
var fs = require('fs');

var async = require('async');
var redis = require('redis');
var sprintf = require('sprintf').sprintf;
var GitHubApi = require('github4');
var request = require('request');
var handlebars = require('handlebars');

var subRedisClient = null;
var redisClient = null;
var github = null;

var NOMIC_ORG = process.env.TRESLEK_NOMIC_ORG;
var NOMIC_REPO = process.env.TRESLEK_NOMIC_REPO;
var NOMIC_USER = process.env.TRESLEK_NOMIC_USER;
var NOMIC_CHANNEL = process.env.TRESLEK_NOMIC_CHANNEL;
var NOMIC_REPO_PATH = process.env.TRESLEK_NOMIC_REPO_PATH;
var NOMIC_PLAYER_BLACKLIST = process.env.TRESLEK_NOMIC_PLAYER_BLACKLIST.split(',');

function loadTemplate(template, callback) {
  fs.readFile(path.join(__dirname, 'templates', template), function(err, file) {
    if (err) {
      throw err;
    }

    callback(null, handlebars.compile(file.toString()));
  });
}

var Nomic = function() {
  this.commands = ['nomic-players', 'nomic-score'];
  this.unload = ['endRedis'];
  this.auto = ['listen'];
  this.usage = {};
};

Nomic.prototype.endRedis = function(callback) {
  subRedisClient.end();
  subRedisClient = null;
  redisClient.quit();
  redisClient = null;
  github = null;
  callback();
};

Nomic.prototype._parseScoreboard = function(callback) {
  var scoreboardUrl = sprintf('https://raw.githubusercontent.com/%s/%s/master/SCOREBOARD.md', NOMIC_ORG, NOMIC_REPO);
  var scores = {};
  request.get(scoreboardUrl, function (error, response, body) {
    if (error || response.statusCode != 200) {
      callback(error);
      return;
    }
    body.split('\n').filter(function (line) {
      return line[0] === '@';
    }).map(function (line) {
      var score = line.split('|').map(function (item) {
        return item.trim();
      });
      scores[score[0].slice(1)] = {
        score: parseInt(score[1], 10)
      };
    });
    callback(null, scores);
  });
};

Nomic.prototype._writeScoreboard = function(scores, callback) {
  loadTemplate('scoreboard.tmpl', function(err, template) {
    if (err) {
      callback(err);
      return;
    }

    var outputScores = Object.keys(scores).map(function(player) {
      return {
        name: player,
        score: scores[player].score
      }
    }).sort(function(a, b) {
      return b.score - a.score;
    });

    fs.writeFile(path.join(NOMIC_REPO_PATH, 'SCOREBOARD.md'), template({scores: outputScores}), function (err) {
      if (err) throw err;
    });
    callback();
  });
};

Nomic.prototype['nomic-score'] = function(bot, to, from, msg, callback) {
  this._parseScoreboard(function(err, scores) {
    if(err) {
      bot.say('Error getting scores.');
      callback();
      return;
    }

    Object.keys(scores).forEach(function(player) {
      bot.say(to, sprintf('%s: %s', player, scores[player].score));
    });
    callback();
  });
};

Nomic.prototype._getActivePlayers = function(callback) {
  var players = [NOMIC_ORG];

  function getForks(err, res) {
    if (err) {
      bot.say(to, "Error getting players.");
      callback();
      return;
    }

    players = players.concat(res.map(function (fork) {
      if (NOMIC_PLAYER_BLACKLIST.indexOf(fork.owner.login) === -1) {
        return fork.owner.login;
      } else {
        return false;
      }
    }).filter(function(player) {
      return player;
    }));

    if (github.hasNextPage(res)) {
      github.getNextPage(res, getForks);
    } else {
      callback(null, players);
    }
  }
  github.repos.getForks({
    user: NOMIC_ORG,
    repo: NOMIC_REPO,
    per_page: 100
  }, getForks);
};

Nomic.prototype['nomic-players'] = function(bot, to, from, msg, callback) {
  this._getActivePlayers(function(err, players) {
    if (err) {
      bot.say(to, "Unable to retrieve players.");
      callback();
      return;
    }

    bot.say(to, players.join(', '));
    callback();
  });
};

Nomic.prototype._handleVote = function(player, pr, vote) {
  var voteStore = sprintf("%s:%s:nomic:%s", NOMIC_ORG, NOMIC_REPO, pr);

  redisClient.zadd(voteStore, vote, player, function(err, callback) {
    console.log('added vote!');
    if (err) {
      console.error('Unable to register vote by player:' + player);
      return;
    }

    console.log(sprintf('Successfully registered vote by player %s on %s'), player, pr);
  });
};

Nomic.prototype.commentCreated = function(bot, data) {
  var plusOne = /^:\+1:$|^\+1$|^-1$|^:-1:$/,
      vote = /([\+-]1)/,
      matches = [];

  if (plusOne.test(data.comment.body.trim())) {
    matches = data.comment.body.match(vote);
    if (!matches) {
      return;
    }

    this._handleVote(data.comment.user.login, data.issue.number, matches[0]);

    bot.say(NOMIC_CHANNEL, sprintf("%s voted %s on %s - %s", data.comment.user.login, matches[0], data.issue.title, data.issue.html_url));
  }
};

Nomic.prototype.listen = function(bot) {
  if (!subRedisClient) {
    subRedisClient = redis.createClient(bot.redisConf.port, bot.redisConf.host);
    subRedisClient.auth(bot.redisConf.pass, function() {});
  }
  if (!redisClient) {
    redisClient = redis.createClient(bot.redisConf.port, bot.redisConf.host);
    redisClient.auth(bot.redisConf.pass, function() {});
  }

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

  subRedisClient.on("message", function(channel, message) {
    message = message.toString();
    var data = JSON.parse(JSON.parse(message).body),
        output;

    if (data) {
      if (data.action === "created" && data.comment && data.issue.state === "open" && data.issue.user.login !== data.comment.user.login) {
        self._getActivePlayers(function(err, players) {
          if (players.indexOf(data.comment.user.login) !== -1) {
            self.commentCreated(bot, data);
          }
        });
      } else if (data.action === "opened") {
        self._getActivePlayers(function(err, players) {
          if (players.indexOf(data.pull_request.user.login !== -1)) {
           self._handleVote(data.pull_request.user.login, data.pull_request.number, 1);
          }
        });
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
  subRedisClient.subscribe(pattern);
};

exports.Plugin = Nomic;
