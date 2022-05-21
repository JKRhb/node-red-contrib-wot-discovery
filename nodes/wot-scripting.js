/**
 * Node-RED node that consumes WoT Thing Descriptions.
 * @module node-red-contrib-wot-discovery/wot-scripting
 */

/**
 *
 * The definition of the wot-scripting node.
 *
 * @param {*} RED The Node-RED object.
 */
module.exports = function (RED) {
  'use strict'

  /**
    * WoT core definitions
    * @type {object}
    * @property {Servient}
    */
  const { Servient } = require('@node-wot/core')
  /**
    * WoT HTTP Bindings
    * @type {object}
    * @property {HttpClientFactory}
    * @property {HttpsClientFactory}
    */
  const { HttpClientFactory, HttpsClientFactory } = require('@node-wot/binding-http')
  /**
    * WoT CoAP Bindings
    * @type {object}
    * @property {CoapClientFactory}
    * @property {CoapsClientFactory}
    */
  const { CoapClientFactory, CoapsClientFactory } = require('@node-wot/binding-coap')
  /**
    * WoT MQTT Bindings
    * @type {object}
    * @property {MqttClientFactory}
    */
  const { MqttClientFactory } = require('@node-wot/binding-mqtt')

  /**
   * Maps the possible operation types to their kind of affordance
   *
   * @type {Object.<string, string>}
   * @constant
   */
  const operationsToAffordanceType = {
    readProperty: 'properties',
    writeProperty: 'properties',
    observeProperty: 'properties',
    invokeAction: 'actions',
    subscribeEvent: 'events'
  }

  /**
   *
   * @type {Object.<string, Servient>}
   */
  const thingCache = {}

  /**
   *
   *
   * @param {Object} config
   */
  function WoTScriptingNode (config) {
    RED.nodes.createNode(this, config)
    const node = this

    const servient = _createWoTServient()

    servient.start().then(thingFactory => {
      node.on('input', function (msg) {
        _handleNodeInput(node, msg, thingFactory)
      })
    }).catch(error => node.error(`wot-scriping: ${error.message}`))

    function _handleNodeInput (node, msg, thingFactory) {
      /* Parameters to the node are read here. Data from the input message is prefered over
            the definition inside the Node-RED node. */
      const operationType = config.operationType || msg.operationType
      const affordanceName = config.affordanceName || msg.affordanceName
      const type = config.affordanceType || msg.affordanceType
      const rawInputValue = (!!config.inputValue && Object.keys(config.inputValue).length > 0) ? config.inputValue : msg.payload
      const inputValue = config.inputValueType === 'json' ? JSON.parse(rawInputValue) : rawInputValue
      const outputVar = msg.outputVar || config.outputVar || 'payload'
      const outputPayload = config.outputPayload
      const outputVarType = msg.outputVarType || config.outputVarType || 'msg'
      const cacheMinutes = config.cacheMinutes || 15

      const affordanceType = operationsToAffordanceType[operationType]

      if (!affordanceType) {
        node.error('Illegal operation type defined!')
        return
      }

      /* msg.thingDescription shall include the thing description that can be gathered
            using the WoT Dicovery node provided with this module. */
      const thingDescription = msg.thingDescription

      let foundAffordances = []

      const affordances = thingDescription[affordanceType]

      // Get a list of affordances the device provides
      const affordanceNames = Object.keys(affordances)

      /* If not the name of the affordance, that shall be fetched, is given
            run this to find the affordances by the given string and write it to
            foundAffordances */

      const filterMode = config.filterMode

      if (filterMode !== 'affordanceName') {
        affordanceNames.forEach((affordanceName) => {
          let affordanceTypes = []
          const affordance = affordances[affordanceName]
          const types = affordance['@type']
          // TODO: Refactor string to array conversion
          if (typeof (types) === 'string') {
            affordanceTypes.push(types)
          } else if (types instanceof Array) {
            affordanceTypes = types
          } else {
            return
          }
          if (affordanceTypes.includes(type)) {
            foundAffordances.push(affordanceName)
          }
        })
        // In case both methods have been selected prefer the affordanceName match if any
        if (filterMode === 'both') {
          if (foundAffordances.includes(affordanceName)) {
            foundAffordances = [affordanceName]
          } else {
            return
          }
          // Quit with an error message if filter type has been set to an illegal value
        } else if (filterMode !== '@type') {
          node.error(`Illegal filter mode "${filterMode}" defined!`)
          return
        }
      } else { // If affordanceName has been selected, use this and quit if not found
        if (affordanceNames.includes(affordanceName)) {
          foundAffordances = [affordanceName]
        } else {
          return
        }
      }

      const identifier = _getTDIdentifier(thingDescription)

      /* Gather the affordances and use cached data if available. Delete the cache
            if the timeout specified has been reached */
      try {
        if (thingCache[identifier]) {
          performOperationsOnThing(foundAffordances, thingCache[identifier].thing, operationType, msg, inputValue, outputVar, outputVarType, outputPayload)
          if (cacheMinutes) {
            thingCache[identifier].timer.refresh()
          }
        } else {
          thingFactory.consume(thingDescription).then(
            (consumedThing) => {
              thingCache[identifier] = { thing: consumedThing }
              performOperationsOnThing(foundAffordances, consumedThing, operationType, msg, inputValue, outputVar, outputVarType, outputPayload)
              if (cacheMinutes) {
                thingCache[identifier].timer = setTimeout(() => {
                  delete thingCache[identifier]
                }, cacheMinutes * 60 * 1000)
              }
            }
          )
        }
      } catch (error) {
        console.log(error)
        node.error('Error:', error.message)
      }
    }

    /**
     * Serially perform multiple operations on a device
     *
     * @param {Object} thing The recent thing description
     * @param {String} operationType The operation that shall be performed
     * @param {String} affordanceName The name of the affordance the operation shall be performed on
     * @param {Object} msg The message that will be sent. It may be modified and will be sent at the end of the operation
     * @param {*} inputValue A value that will be sent in the operation (depending on the type)
     * @param {String} outputVar An attribute name the returned value will be written to
     * @param {String} outputVarType The place the data is going to be written to. Either "msg", "flow" or "global"
     * @param {Boolean} outputPayload Shall the data be written to "msg.payload" as well?
     */
    function performOperationsOnThing (foundAffordances, consumedThing, operationType, msg, inputValue, outputVar, outputVarType, outputPayload) {
      foundAffordances.forEach((affordance) => {
        performOperationOnThing(
          consumedThing,
          operationType,
          affordance,
          msg,
          inputValue,
          outputVar,
          outputVarType,
          outputPayload
        )
      })
    }

    /**
     *  Asyncronously resolve an InteractionOutput.
     *
     * @param {InteractionOutput} output The output to resolve.
     * @return The resolved output.
     */
    async function _resolveOutput (output) {
      return await output.value()
    }

    // TODO: This signature has to be shortened
    /**
     * Actually perform the operation that has been chosen on the device
     *
     * @param {Object} thing The recent thing description
     * @param {String} operationType The operation that shall be performed
     * @param {String} affordanceName The name of the affordance the operation shall be performed on
     * @param {Object} msg The message that will be sent. It may be modified and will be sent at the end of the operation
     * @param {*} inputValue A value that will be sent in the operation (depending on the type)
     * @param {String} outputVar An attribute name the returned value will be written to
     * @param {String} outputVarType The place the data is going to be written to. Either "msg", "flow" or "global"
     * @param {Boolean} outputPayload Shall the data be written to "msg.payload" as well?
     */
    function performOperationOnThing (thing, operationType, affordanceName, msg, inputValue, outputVar, outputVarType, outputPayload) {
      // TODO: This signature has to be shortened
      const thingDescription = thing.getThingDescription()
      switch (operationType) {
        case 'readProperty':
          thing.readProperty(affordanceName).then(_resolveOutput).then(output => {
            _handleOutput(msg, output, outputVar, outputVarType, outputPayload)
          }).catch(error => node.error(error))
          break
        case 'writeProperty':
          if (!inputValue) {
            node.error('No input value given!')
            return
          }
          thing.writeProperty(affordanceName, inputValue).then(_resolveOutput).then(output => {
            _handleOutput(msg, output, outputVar, outputVarType, outputPayload)
          }).catch(error => node.error(error))
          break
        case 'observeProperty':
          thing.observeProperty(affordanceName).then(_resolveOutput).then(output => {
            _handleOutput(msg, output, outputVar, outputVarType, outputPayload)
          }).catch(error => node.error(error))
          break
        case 'invokeAction': {
          let invokedAction
          const constValue = _getConstValueInput(thingDescription, affordanceName)
          if (constValue) {
            invokedAction = thing.invokeAction(affordanceName, constValue)
          } else if (inputValue) {
            invokedAction = thing.invokeAction(affordanceName, inputValue)
          } else {
            invokedAction = thing.invokeAction(affordanceName)
          }
          invokedAction.then(_resolveOutput).then(output => {
            _handleOutput(msg, output, outputVar, outputVarType, outputPayload)
          }).catch(error => node.error(error))
          break
        }
        case 'subscribeEvent':
          thing.subscribeEvent(affordanceName).then(_resolveOutput).then(output => {
            _handleOutput(msg, output, outputVar, outputVarType, outputPayload)
          }).catch(error => node.error(error))
          break

        default:
          break
      }
    }

    /**
     * Get the constant value of an action
     *
     * @param {Object} thingDescription
     * @param {String} affordanceName The affordanceName of the action
     * @return {Number} The Value or null if an error occurred
     */
    function _getConstValueInput (thingDescription, affordanceName) {
      try {
        const affordance = thingDescription.actions[affordanceName]
        return affordance.input.const
      } catch (error) {
        return null
      }
    }

    /**
     * Handle the output of the device
     *
     * @param {Object} msg The message this node will send
     * @param {Object} output The output received by the device
     * @param {String} outputVar The attribute's name the output is going to be saved
     * @param {String} outputVarType The place the data is going to be written to. Either "msg", "flow" or "global"
     * @param {Boolean} outputPayload Shall the data be written to "msg.payload" as well?
     */
    function _handleOutput (msg, output, outputVar, outputVarType, outputPayload) {
      if (output != null) {
        switch (outputVarType) {
          case 'msg':
            msg[outputVar] = output
            break
          case 'flow':
            node.context().flow.set(outputVar, output)
            break
          case 'global':
            node.context().global.set(outputVar, output)
            break
          default:
            throw Error('Invalid output context given! Possible values are msg, flow or global!')
        }
        if (outputPayload) {
          msg.payload = output
        }
      }
      node.send(msg)
    }

    /**
     * Get id, base URL and the title of a thing description
     *
     * @param {Object} thingDescription Object as provided by the WoT Discovery node
     * @return {Object} Identifier object providing the attributes id, base and title
     */
    function _getTDIdentifier (thingDescription) {
      const identifier =
                thingDescription.id ||
                thingDescription.base ||
                thingDescription.title
      return identifier
    }

    function _createWoTServient () {
      const servient = new Servient()
      servient.addClientFactory(new HttpClientFactory(null))
      servient.addClientFactory(new HttpsClientFactory(null))
      servient.addClientFactory(new CoapClientFactory(null))
      servient.addClientFactory(new CoapsClientFactory(null))
      servient.addClientFactory(new MqttClientFactory(null))

      return servient
    }
  }
  RED.nodes.registerType('wot-scripting', WoTScriptingNode)
}
