/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2019 Covistra Technologies Inc.
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation 
 * files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, 
 * merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished 
 * to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES 
 * OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE 
 * LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN 
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
const sortBy = require('lodash.sortby');
const bodyParser = require('body-parser');
const validatePayload = require('./validate-payload.middleware');

module.exports = function({ proc, logger }) {

    const Operation = require('./operation')({ proc, logger });

    function doRead(operation) {
        logger.debug("performing a read operation", operation);
        operation.result = operation.resource.backend.then(backend => backend.read(operation));
        return operation;
    }

    function doList(operation) {
        logger.debug("performing a list operation", operation);
        operation.result = operation.resource.backend.then(backend => {
            logger.debug("backend", backend);
            return backend.list(operation)
        });
        return operation;
    }

    function doCreate(operation) {
        logger.debug("performing a create operation", operation);
        operation.result = operation.resource.backend.then(backend => backend.create(operation)).then(result => {
            logger.debug("create result", result);
            if (result.result.ok && result.insertedCount === 1) {
                operation.res.status(201);
                if (operation.resource.schema) {
                    logger.debug("Let's coerce our return value");
                    return operation.resource.getSchema(operation.key).then(schema => {
                        logger.debug("we have found our schema")
                        if (schema.validate(result.ops[0])) {
                            logger.debug("result is valid, let's return it", result.ops[0]);
                            return result.ops[0];
                        } else {
                            logger.debug("schema is invalid", schma.errors);
                            return result.ops[0];
                        }
                    })
                } else {
                    return result.ops[0];
                }
            } else {
                return result.result;
            }
        });
        return Promise.props(operation);
    }

    function doUpdate(operation) {
        logger.debug("performing a update operation", operation);
        operation.result = operation.resource.backend.then(backend => backend.update(operation));
        return operation;
    }

    function doPatch(operation) {
        logger.debug("performing a patch operation", operation);
        operation.result = operation.resource.backend.then(backend => backend.patch(operation));
        return operation;
    }

    function doRemove(operation) {
        logger.debug("performing a remove operation", operation);
        operation.result = operation.resource.backend.then(backend => backend.remove(operation));
        return operation;
    }

    class Resource {
        constructor(spec) {
            this.$ready = Promise.resolve(spec).then(data => {
                Object.assign(this, data)
                // Configure db backend
                this.backendKey = this.backend.ref || this.backend || this.backendKey;
                this.backendConfig = this.backend.config || {};

                this.backend = proc.resolve(this.backendKey, { type: 'rest-backend' }).then(deps => {
                    logger.debug("Resolved backend", deps);
                    return deps[this.backendKey];
                });

                // Load associated schema
                this.schemaKey = this.schema;
                this.schema = proc.resolve(this.schema, { type: 'schema' });

                // Configure security 
                // Load all required middleware
            });

        }
        getSchema(opkey) {
            return this.$ready.then(() => this.schema.then(schemas => {
                return new XLR8.JsonSchema(schemas[this.schemaKey]);
            }));
        }
        get endpoints() {
            return this.$ready.then(() => {
                return [{
                    key: this.key,
                    method: 'get',
                    path: `/${this.path || this.key}/:id`,
                    handler: [this.setupOperation('read'), this.handle(), this.renderOperation(), this.handleErrors()]
                }, {
                    key: this.key,
                    method: 'get',
                    path: `/${this.path || this.key}`,
                    handler: [this.setupOperation('list'), this.handle(), this.renderOperation(), this.handleErrors()]
                }, {
                    key: this.key,
                    method: 'post',
                    path: `/${this.path || this.key}`,
                    handler: [this.setupOperation('create'), this.handle(), this.renderOperation(), this.handleErrors()]
                }, {
                    key: this.key,
                    method: 'put',
                    path: `/${this.path || this.key}/:id`,
                    handler: [this.setupOperation('update'), this.handle(), this.renderOperation(), this.handleErrors()]
                }, {
                    key: this.key,
                    method: 'patch',
                    path: `/${this.path || this.key}/:id`,
                    handler: [this.setupOperation('patch'), this.handle(), this.renderOperation(), this.handleErrors()]
                }, {
                    key: this.key,
                    method: 'delete',
                    path: `/${this.path || this.key}/:id`,
                    handler: [this.setupOperation('remove'), this.handle(), this.renderOperation(), this.handleErrors()]
                }];
            });
        }
        setupOperation(opkey) {
            logger.debug("Setting up operation %s middleware", opkey);
            let targetResource = this;

            let handlers = [bodyParser.json(), function(req, res, next) {
                let op = new Operation(targetResource, opkey, req, res);
                req.opkey = opkey;
                req.op = Promise.resolve(op);
                next();
            }.bind(this)];

            if (targetResource.schema) {
                handlers.push(validatePayload({ proc, logger, opkey }));
            }

            return handlers;
        }
        renderOperation() {
            return function(req, res, next) {
                return req.op.then(operation => {
                    if (operation.result) {
                        return operation.result.then(result => {
                            if (result) {
                                res.json(result)
                            } else {
                                res.status(404).end(`${operation.resource.key}.${operation.id}.not.found`);
                            }
                        });
                    } else {
                        res.end();
                    }
                });
            }.bind(this);
        }
        handleErrors() {
            return function(err, req, res, next) {
                if (err && err.statusCode !== 400) {
                    logger.error("rest-error:", err);
                }

                if (err.statusCode) {
                    res.status(err.statusCode).json({ message: err.message, details: err.details });
                } else {
                    res.status(500).end(err.message || 'general.error');
                }
            }.bind(this);
        }
        handle() {
            return function(req, res, next) {
                if (req.op) {
                    return req.op.then(op => {
                        logger.trace("Handle operation", op);
                        let handler = this[op.key];
                        if (typeof handler === 'function') {
                            return handler.call(this, op).then(result => next(null, result)).catch(next);
                        } else {
                            next();
                        }
                    });
                } else {
                    next();
                }
            }.bind(this);
        }
        async executeHooks(phase, operation) {
            return this.$ready.then(() => {
                let phaseHooks = this[phase] || [];
                let hooks = sortBy(phaseHooks.filter(hook => hook.op === operation.key), hook => hook.priority || 5);
                return Promise.reduce(hooks, (operation, hook) => hook.fn(operation), operation);
            });
        }
        async executeHandler(operation, defaultHandler) {
            return this.$ready.then(() => {
                let handler = this.handlers && this.handlers[operation.key];
                if (handler) {
                    return handler(operation, defaultHandler);
                } else {
                    return defaultHandler(operation);
                }
            });
        }
        async read(operation) {
            logger.debug("Handling read %s operation", this.key, operation);
            return this.executeHooks('pre', operation).then(op => this.executeHandler(op, doRead))
                .then(operation => this.executeHooks('post', operation));
        }
        async list(operation) {
            logger.debug("Handling list %s operation", this.key, operation);
            return this.executeHooks('pre', operation).then(op => this.executeHandler(op, doList))
                .then(operation => this.executeHooks('post', operation));
        }
        async create(operation) {
            logger.debug("Handling create %s operation", this.key, operation);
            return this.executeHooks('pre', operation).then(op => this.executeHandler(op, doCreate))
                .then(operation => this.executeHooks('post', operation));
        }
        async update(operation) {
            logger.debug("Handling update %s operation", this.key, operation);
            return this.executeHooks('pre', operation).then(op => this.executeHandler(op, doUpdate))
                .then(operation => this.executeHooks('post', operation));
        }
        async patch(operation) {
            logger.debug("Handling patch %s operation", this.key, operation);
            return this.executeHooks('pre', operation).then(op => this.executeHandler(op, doPatch))
                .then(operation => this.executeHooks('post', operation));
        }
        async remove(operation) {
            logger.debug("Handling remove %s operation", this.key, operation);
            return this.executeHooks('pre', operation).then(op => this.executeHandler(op, doRemove))
                .then(operation => this.executeHooks('post', operation));
        }
    }

    return Resource;
}