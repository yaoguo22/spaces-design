/*
 * Copyright (c) 2014 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */


define(function (require, exports, module) {
    "use strict";

    var React = require("react"),
        Fluxxor = require("fluxxor"),
        FluxMixin = Fluxxor.FluxMixin(React),
        StoreWatchMixin = Fluxxor.StoreWatchMixin;

    var adapterOS = require("adapter/os");

    var Scrim = React.createClass({
        mixins: [FluxMixin, StoreWatchMixin("tool", "ui", "application")],

        /**
         * Dispatches (synthetic) click events from the scrim to the currently
         * active tool.
         * 
         * @private
         * @param {SynthenticEvent} event
         */
        _handleClick: function (event) {
            var tool = this.state.current;

            if (tool && tool.onClick) {
                tool.onClick.call(this, event);
            }
        },

        /**
         * Dispatches (synthetic) doubleclick events from the scrim to the currently
         * active tool.
         *
         * @private
         * @param {SyntheticEvent} event
         */
        _handleDoubleClick: function (event) {
            var tool = this.state.current,
                flux = this.getFlux();

            // If there are no documents open, send a "Open" command to Photoshop
            if (!flux.store("application").getCurrentDocument()) {
                flux.actions.menu.native({ commandID: 20 });
                return;
            }

            if (tool && tool.onDoubleClick) {
                tool.onDoubleClick.call(this, event);
            }
        },

        /**
         * Dispatches (synthetic) mousedown events from the scrim to the currently
         * active tool.
         * 
         * @private
         * @param {SynthenticEvent} event
         */
        _handleMouseDown: function (event) {
            var tool = this.state.current;

            if (window.document.activeElement !== window.document.body) {
                window.document.activeElement.blur();
            }

            if (tool && tool.onMouseDown) {
                tool.onMouseDown.call(this, event);
            }
        },

        /**
         * Dispatches (synthetic) mouseup events from the scrim to the currently
         * active tool.
         * 
         * @private
         * @param {SynthenticEvent} event
         */
        _handleMouseUp: function (event) {
            var tool = this.state.current;

            if (tool && tool.onMouseUp) {
                tool.onMouseUp.call(this, event);
            }
        },

        /**
         * Dispatches (synthetic) mouseMove events from the scrim to the currently
         * active tool.
         * 
         * @private
         * @param {SynthenticEvent} event
         */
        _handleMouseMove: function (event) {
            var tool = this.state.current;

            if (tool && tool.onMouseMove) {
                tool.onMouseMove.call(this, event);
            }
        },

        /**
         * Dispatches custom keyup events from the window to the currently
         * active tool.
         * 
         * @private
         * @param {CustomEvent} event
         */
        _handleKeyUp: function (event) {
            // Don't dispatch the key event if a focusable DOM element is active
            if (event.target !== window.document.body) {
                return;
            }

            adapterOS.resetCursor();

            var tool = this.state.current;
            if (tool && tool.onKeyUp) {
                tool.onKeyUp.call(this, event);
            }
        },

        /**
         * Dispatches custom keydown events from the window to the currently
         * active tool.
         * 
         * @private
         * @param {CustomEvent} event
         */
        _handleKeyDown: function (event) {
            // Don't dispatch the key event if a focusable DOM element is active
            if (event.target !== window.document.body) {
                return;
            }

            adapterOS.resetCursor();

            var tool = this.state.current;
            if (tool && tool.onKeyDown) {
                tool.onKeyDown.call(this, event);
            }
        },

        getStateFromFlux: function () {
            var flux = this.getFlux(),
                toolState = flux.store("tool").getState(),
                uiState = flux.store("ui").getState(),
                applicationStore = flux.store("application"),
                applicationState = applicationStore.getState(),
                document = applicationStore.getCurrentDocument();

            return {
                current: toolState.current,
                transform: uiState.inverseTransformMatrix,
                overlaysEnabled: uiState.overlaysEnabled,
                document: document,
                activeDocumentInitialized: applicationState.activeDocumentInitialized,
                recentFilesInitialized: applicationState.recentFilesInitialized
            };
        },

        shouldComponentUpdate: function (nextProps, nextState) {
            // Don't re-render if we're just going temporarily inactive so that
            // the UI doesn't blink unnecessarily.
            if (this.props.active && !nextProps.active) {
                return false;
            }

            // Don't re-render until either the active document or recent files
            // are initialized.
            if (!nextState.activeDocumentInitialized || !nextState.recentFilesInitialized) {
                return false;
            }

            return true;
        },

        /**
         * Adds adapter key-event listeners.
         */
        componentWillMount: function () {
            window.addEventListener("adapterKeydown", this._handleKeyDown);
            window.addEventListener("adapterKeyup", this._handleKeyUp);
        },

        /**
         * Removes adapter key-event listeners.
         */
        componentWillUnmount: function () {
            window.removeEventListener("adapterKeydown", this._handleKeyDown);
            window.removeEventListener("adapterKeyup", this._handleKeyUp);
        },

        /**
         * Renders the current tool overlay if there is one
         * @param {string} transform affine transformation string
         * @private
         */
        _renderToolOverlay: function (transform) {
            var tool = this.state.current;

            if (tool && tool.toolOverlay) {
                var ToolOverlay = tool.toolOverlay;

                return (
                    <ToolOverlay transformString={transform} ref="toolOverlay"/>
                );
            }

            return null;
        },
        // Stringifies CanvasToWindow transformation for all SVG coordinates
        _getTransformString: function (transformMatrix) {
            if (!transformMatrix) {
                return "";
            }

            return "matrix(" + transformMatrix.join(",") + ")";
        },

        render: function () {
            var document = this.state.document,
                disabled = document && document.unsupported,
                transform = this.state.transform,
                overlays = !disabled && this.state.overlaysEnabled,
                transformString = this._getTransformString(transform),
                toolOverlay = (overlays && transform) ? this._renderToolOverlay(transformString) : null;

            // Only the mouse event handlers are attached to the scrim
            return (
                <div
                    ref="scrim"
                    className="scrim"
                    onClick={!disabled && this._handleClick}
                    onDoubleClick={!disabled && this._handleDoubleClick}
                    onMouseDown={!disabled && this._handleMouseDown}
                    onMouseMove={!disabled && this._handleMouseMove}
                    onMouseUp={!disabled && this._handleMouseUp}>
                    <svg width="100%" height="100%">
                        <g id="overlay" width="100%" height="100%">
                            {toolOverlay}
                        </g>
                    </svg>
                </div>
            );
        }
    });

    module.exports = Scrim;
});
