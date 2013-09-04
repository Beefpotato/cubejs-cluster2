var _ = require('underscore'),
	when = require('when'),
	timeout = require('when/timeout'),
	cluster = require('cluster'),
	assert = require('assert'),
	util = require('util'),
	execFile = require('child_process').execFile,
	BigNumber = require('bignumber.js'),
	Worker = require('./worker.js').Worker,
	exitIfBusyPort = require('./utils.js').exitIfBusyPort,
	writePid = require('./utils.js').writePid,
	getNodeInspectorPath = require('./utils.js').getNodeInspectorPath,
	enable = require('./ecv.js').enable;

var masterDeferred = when.defer(),
	masterPromise = exports.master = masterDeferred.promise;

/**
 * Slave is an image of the worker at the Master's runtime, to simplify the state machine
 */
var Slave = exports.Slave = function Slave(master, worker, options, env){

	var _this = this;

	console.log('slave built');

	_this.cacheManager = env.CACHE_MANAGER;
	_this.debug = env.debug;
	_this.pid = worker.process.pid;
	_this.worker = worker;

	_this.forkedState = {

		'disconnect': function(){
			
			worker.disconnect();
		},

		'whenOnline': function(){

			if(_this.debug){
				//we could enable debugging here
				master.emitter.once('debug-started', function(){
					_this.emitter.emit('run', [_this.pid]);
				});

				master.emitter.once('debug-finished', function(){
					_this.disconnect();
				});

				_this.debug();
			}
		},

		'whenListening': function(){

			_this.state = _this.activeState;

			master.emitter.emit(util.format('worker-%d-listening', worker.process.pid), ['self']);
		},

		'whenHeartbeat': function(){
			//no interest
		},

		'whenExit': function(){

			if(!worker.suicide){//accident, must be revived
				master.fork(options, env);
			}
		}
	};

	_this.activeState = {

		'disconnect': function(){
			
			worker.disconnect();
		},

		'whenHeartbeat': function(heartbeat){
			//here's the key feature for cluster3, based on the historic tps info, memory usage, gc rate, we could determine if a slave should
			//enter an old state from active

			if(master.markOld(heartbeat)){

				_this.activeState = _this.oldState;

				var successor = master.fork(options, env);
				//when successor is in place, the old worker could be discontinued finally
				master.emitter.once(util.format('worker-%d-listening', successor.process.pid), function(){

					master.emitter.emit('disconnect', ['master', worker.pid]);
				});
			}
		},

		'whenExit': function(){

			if(!worker.suicide){//accident, must be revived
				master.fork(options, env);
			}
		}
	};

	_this.oldState = {

		'disconnect': function(){
			
			worker.disconnect();
		},

		'whenExit': function(){

			_this.state = _this.diedState;
		}
	};

	_this.diedState = {

		'disconnect': function(){
			//already disconnected	
		},

		'whenExit': function(){
			//already exit
		}
	};

	_this.state = _this.forkedState;
};

Slave.prototype.debug = function(){

	this.worker.process.kill('SIGUSR1');//make it debug ready
};

Slave.prototype.disconnect = function(){

	return this.state.disconnect();
};

Slave.prototype.whenOnline = function(){

	return this.state.whenOnline();
};

Slave.prototype.whenListening = function(){

	return this.state.whenListening();
};

Slave.prototype.whenHeartbeat = function(heartbeat){

	return this.state.whenHeartbeat(heartbeat);
};

Slave.prototype.whenExit = function(){

	return this.state.whenExit();
};

var Master = exports.Master = function(proc, options){

	var _this = this.initialize(proc, options);

	masterDeferred.resolve(_this);

	return _this;
};

Master.prototype.initialize = function(proc, options){

	var _this = this;

	writePid(process.pid);
		
	if(cluster.isMaster) {

		_.extend(_this, {
			'pid': proc.pid,
			'process': proc,
			'emitter': options.emitter,
			'createServer': options.monCreateServer,
			'app': options.monApp,
			'port': options.monPort,
			'warmUp': function(){

				_this.fork(_this.options, {
					'CACHE_MANAGER': true
				});

				enable(options.monApp, options.ecv);

				_.each(_.range(0, _this.noWorkers), function(ith){
					return _this.fork(_this.options);
				});

				//wait for all slaves to be ready, and then enable ECV as the last step
				_this.markUp();	
			},
			'noWorkers': options.noWorkers,
			'markOld': options.markOld || function(heartbeat){

				var thisTPS = heartbeat.durations / heartbeat.transactions,
					historicTPS = new BigNumber(heartbeat.totalDurations, 16).dividedBy(new BigNumber(heartbeat.totalTransactions, 16)).toPrecision(32);

				//over 5% increase?
				if(thisTPS > historicTPS && (thisTPS - historicTPS) * 20 > historicTPS){
					//verify if it's due to GC
					var gc = heartbeat.gc;
					if(gc.usage > 0.9){
						return true;
					}
				}
				return false;
			},
			'stopTimeout': options.stopTimeout,
			'debugPort': options.debugPort,
			'options': options,
			'slaves': {

			},
			'status': require('./cluster-status.js').status(options.emitter)
		});

		cluster.on('fork', function(worker){
			_this.slaves[worker.process.pid] = _this.slaves[worker.process.pid] || new Slave(_this, worker, options, worker.process.env || {});
			_this.slaves[worker.process.pid].worker = worker;
		});

		cluster.on('online', function(worker){
			_this.slaves[worker.process.pid].whenOnline();
		});

		cluster.on('listening', function(worker){
			_this.slaves[worker.process.pid].whenListening();
		});

		cluster.on('exit', function(worker){
			_this.slaves[worker.process.pid].whenExit();
		});

		_this.emitter.on('heartbeat', function(heartbeat){
			_this.slaves[heartbeat.pid].whenHeartbeat(heartbeat);
		});

		process.once('SIGINT', _.bind(_this.whenStop, _this));
		process.once('SIGTERM', _.bind(_this.whenExit, _this));

		assert.ok(_this.createServer);
		assert.ok(_this.app);
		assert.ok(_this.port);

		exitIfBusyPort('localhost', _this.port);
		exitIfBusyPort('localhost', _this.options.port);

		return _this;
	}
	else if(proc.env.CACHE_MANAGER){

		var manager = require('./cache-mgr.js');
		_.extend(options, {
			'createServer': manager.createServer,
			'app': manager.app,
			'port': manager.port,
			'warmUp': manager.afterServerStarted
		});

		return new Worker(proc, options);
	}
	else{

		_.extend(options, {
			'debug': process.env.debug
		});

		return new Worker(proc, options);
	}
};

Master.prototype.listen = function(){

	var _this = this,
		createServer = _this.createServer,
		monApp = _this.app,
		monPort = _this.port,
		warmUp = _this.warmUp,
		wait = _this.timeout;

	assert.ok(createServer);
	assert.ok(monApp);
	assert.ok(monPort);

	var deferred = when.defer(),
		server = createServer(monApp).listen(monPort, function(){
			deferred.resolve({
				'server': server,
				'app': monApp,
				'port': monPort,
				'master': _this,
				'worker': null
			});
		});

	return (wait > 0 ? timeout(_this.timeout, deferred.promise) : deferred.promise)
		.then(function(resolve){
			
			warmUp();
			return resolve;
		});
};

Master.prototype.debug = function debug(pid){

	var _this = this,
		slavesCount = 0;

	_this.markDown();

	//debug fresh
	_.each(_.filter(_this.slaves, function(slave){
			return !slave.cacheManager && pid !== slave.pid;
		}),
		function(slave){
			slavesCount += 1;
			slave.disconnect();
		});

	//send signal to the slave
	if(!pid){
		_this.fork(_this.options, {
			'debug': true
		});
	}
	else{
		var debugging = _this.slaves[pid];
		debugging.debug();

		_this.emitter.once('debug-finished', function(){
			debugging.disconnect();
		});
	}
	
	var inspectorPath = getNodeInspectorPath();
	assert.ok(inspectorPath);

	var inspector = execFile(inspectorPath, ['--web-port=' + _this.debugPort]),
		buff = '';

	inspector.stdout.on('data', function onData(data){

		buff += data;
		//test util the inspectorUrl is matched, suggesting that the node-inspector is running
		var inspectorUrl = buff.match(/.+(http:\/\/0.0.0.0:[\d]+\/debug\?port=[\d]+).+/i);
		if(inspectorUrl){

			inspector.stdout.removeListener('data', onData);
			_this.emitter.emit('debug-inspector', ['master'], inspectorUrl);
		}
	});

	_this.emitter.once('debug-finished', function(){//u'll hear back from the debug app about this

		inspector.kill('SIGTERM');

		//restore the workers
		_.each(_.range(0, slavesCount), function(ith){
			_this.fork(_this.options);
		});

		//mark up ecv now
		_this.markUp();
	});
};

Master.prototype.markDown = function markUp(){
	//mark down ecv
	_this.emitter.emit('warning', ['self'], {
		'command': 'disable'
	});
};

Master.prototype.markUp = function markUp(){
	//mark down ecv
	_this.emitter.emit('warning', ['self'], {
		'command': 'enable'
	});
};

Master.prototype.fork = function(options, env){

	var _this = this,
		forked = cluster.fork(env);

	_this.slaves[forked.process.pid] = new Slave(_this, forked, options, env);

	return forked;
};

Master.prototype.whenStop = function whenStop(){

	var _this = this,
		cycle = 1000,
		threshold = Date.now() + _this.stopTimeout,
		gracefully = function(){

			if(_.keys(_this.slaves).length === 0){//wait till each live slaves to be disconnected, then exit
				process.exit(0);
			}

			if(Date.now() >= threshold){
				process.exit(-1);
			}
			else{
				setTimeout(gracefully, cycle);
			}
		};//check every second

	_.each(_this.slaves, function(slave){

		slave.disconnect();
	});

	gracefully();//shutdown gracefully
};

Master.prototype.whenExit = function whenExit(){

	_.each(_this.slaves, function(slave){

		slave.disconnect();
	});

	process.exit(-1);//shutdown bruteforcely
};