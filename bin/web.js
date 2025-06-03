var _ = require('underscore');
var express = require('express');
var http = require('http');
var logger = require('winston');
var opt = require('optimist');
var path = require('path');

var argv = require('optimist')
	.describe('config', 'Location of the configuration file').default('config', './config.json')
	.argv;

if (argv.h || argv.help) {
	opt.showHelp();
	return;
}

logger.cli();
logger.level = 'debug';

var config = loadConfig(argv.config);

function loadConfig(configPath) {
	var config = {
		port: 8080,
		content: 'localhost:9000',
		masterServer: 'localhost:27950',
		useWebRTC: true
	};

	try {
		logger.info('loading config file from ' + configPath + '..');
		var data = require(configPath);
		_.extend(config, data);
	} catch (e) {
		logger.warn('failed to load config', e);
	}

	return config;
}

(function main() {
	var app = express();

	// Import WebRTC client files middleware
	var createClientFilesMiddleware = require('../lib/client-files-middleware');

	app.set('views', __dirname);
	app.set('view engine', 'ejs');

	// Configure WebRTC client files middleware
	var clientFilesMiddleware = createClientFilesMiddleware({
		masterServer: 'ws://' + config.masterServer,
		useWebRTC: config.useWebRTC
	});

	// Serve static files from build directory
	app.use(express.static(path.join(__dirname, '..', 'build')));
	
	// Serve WebRTC client files
	app.use(clientFilesMiddleware);
	
	// Render index.ejs with template variables
	app.use(function (req, res, next) {
		res.locals.content = config.content;
		res.locals.useWebRTC = config.useWebRTC;
		res.locals.masterServer = config.masterServer;
		res.render('index');
	});

	var server = http.createServer(app);
	server.listen(config.port, function () {
		logger.info('web server is now listening on ' +  server.address().address + ":" + server.address().port);
	});

	return server;
})();