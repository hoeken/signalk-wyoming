We are going to explore the idea of building a series of plugins for SignalK in order to add integration for the Wyoming protocol.

Currently the plan is to create the following SignalK plugins:

- signalk-wyoming (orchestrator + self-satellite)
- signalk-whisper (stt)
- signalk-piper (tts)
- signalk-openwakeword

The current plan is to make each plugin a containerized microservice using signalk-container and https://github.com/hoeken/signalk-container-helper

There are a number of things to discuss and decide, such as:

- do we make the signalk-wyoming orchestrator and self-satellite the same plugin?
- what is the exact role of the orchestrator?
- in signalk style, i would like incoming voice commands to be sent to a subscribable signalk path, such as voice.command
- there should also be a number of ways to interact with the system, such as:
  - generating a tts event, sent to all satellites, or a subset.
    - provide access via:
      - api
      - PUT command to a path
      - inter-plugin communication (SignalK's PropertyValues mechanism (app.emitPropertyValue / app.onPropertyValues))
- what is the minimum set of configuration parameters we need for each microservice?
  - what would be good stretch goals, or 'nice to have'?
- which of these plugins can be standalone, and which ones require other plugins?
- how do we handle audio configuration, which can be frustrating at the best of times?