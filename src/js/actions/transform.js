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

define(function (require, exports) {
    "use strict";

    var Promise = require("bluebird"),
        Immutable = require("immutable");
        
    var descriptor = require("adapter/ps/descriptor"),
        documentLib = require("adapter/lib/document"),
        layerLib = require("adapter/lib/layer"),
        artboardLib = require("adapter/lib/artboard"),
        contentLib = require("adapter/lib/contentLayer"),
        unitLib = require("adapter/lib/unit");

    var events = require("../events"),
        locks = require("js/locks"),
        log = require("js/util/log"),
        layerActions = require("./layers"),
        collection = require("js/util/collection"),
        locking = require("js/util/locking"),
        layerActionsUtil = require("js/util/layeractions"),
        headlights = require("js/util/headlights"),
        strings = require("i18n!nls/strings");

    /**
     * play/batchPlay options that allow the canvas to be continually updated.
     *
     * @private
     * @type {object}
     */
    var _paintOptions = {
        immediateUpdate: true,
        quality: "draft"
    };


    /**
     * Helper function that will break down a given layer to all it's children
     * and return layerActionsUtil compatible layer actions to move all the kids
     * so the overall selection ends at given position
     *
     * @param {Document} document
     * @param {Layer} targetLayer
     * @param {{x: number, y: number}} position
     * @param {Array.<{layer: Layer, x: number, y: number}>} moveResults payload for updating each layer's bounds
     *
     * @return {Immutable.List<{layer: Layer, playObject: PlayObject}>}
     */
    var _getMoveLayerActions = function (document, targetLayer, position, moveResults) {
        var overallBounds = document.layers.childBounds(targetLayer),
            movingLayers = document.layers.descendants(targetLayer),
            deltaX = position.hasOwnProperty("x") ? position.x - overallBounds.left : 0,
            deltaY = position.hasOwnProperty("y") ? position.y - overallBounds.top : 0,
            documentRef = documentLib.referenceBy.id(document.id);

        moveResults = moveResults || [];

        return movingLayers.reduce(function (playObjects, layer) {
            if (!layer.bounds || layer.bounds.empty) {
                return playObjects;
            }
            var layerRef = [documentRef, layerLib.referenceBy.id(layer.id)],
                translateObj;

            if (layer.isArtboard) {
                var newX = position.hasOwnProperty("x") ? position.x : layer.bounds.left,
                    newY = position.hasOwnProperty("y") ? position.y : layer.bounds.top,
                    boundingBox = {
                        top: newY,
                        bottom: newY + layer.bounds.height,
                        left: newX,
                        right: newX + layer.bounds.width
                    };

                moveResults.push({
                    layer: layer,
                    x: newX,
                    y: newY
                });

                translateObj = artboardLib.transform(layerRef, boundingBox);
            } else {
                moveResults.push({
                    layer: layer,
                    x: layer.bounds.left + deltaX,
                    y: layer.bounds.top + deltaY
                });
                translateObj = layerLib.translate(layerRef, deltaX, deltaY);
            }


            return playObjects.push({
                layer: layer,
                playObject: translateObj
            });
        }, Immutable.List(), this);
    };
         
    /**
     * For two layers, calculates a new top left for both, keeping them within
     * the same bounding box, but swapping their locations
     *
     *  - If the two layers' top, bottom or vertical centers are close to each other
     *      We do intelligent swapping horizontally, but keep the layers in the same vertical location
     *      These cases usually apply to things like: Number and the numbered list item
     *      
     *  - If left, horizontal center, or right edges are close to each other
     *      We swap just the tops, keeping the layers in same horizontal location
     *      This applies to cases like two items in a list
     *      
     *  - Otherwise, we swap the layers top/left corners with each other. This applies to all other general cases
     *
     * @private
     * @param {Document} document
     * @param {Immutable.Iterable.<Layer>} layers
     * @param {number} sensitivity Fraction of the edge difference to consider two layers on same axis
     * @return {Immutable.List.<{x: number, y: number}>} New position objects for layers
     */
    var _calculateSwapLocations = function (document, layers, sensitivity) {
        sensitivity = sensitivity || 10;
        
        var l1 = document.layers.childBounds(layers.get(0)),
            l2 = document.layers.childBounds(layers.get(1)),
            boundingBox = {
                left: Math.min(l1.left, l2.left),
                right: Math.max(l1.right, l2.right),
                top: Math.min(l1.top, l2.top),
                bottom: Math.max(l1.bottom, l2.bottom)
            },
            l1VertCenter = l1.top + l1.height / 2,
            l2VertCenter = l2.top + l2.height / 2,
            l1HorzCenter = l1.left + l1.width / 2,
            l2HorzCenter = l2.left + l2.width / 2,
            heightFraction = (boundingBox.bottom - boundingBox.top) / sensitivity,
            widthFraction = (boundingBox.right - boundingBox.left) / sensitivity,
            verticalEdgeClose = Math.abs(l1.left - l2.left) < widthFraction ||
                Math.abs(l1.right - l2.right) < widthFraction ||
                Math.abs(l1HorzCenter - l2HorzCenter) < widthFraction,
            horizontalEdgeClose = Math.abs(l1.top - l2.top) < heightFraction ||
                Math.abs(l1.bottom - l2.bottom) < heightFraction ||
                Math.abs(l1VertCenter - l2VertCenter) < heightFraction,
            l1Left = null,
            l1Top = null,
            l2Left = null,
            l2Top = null;

        if (verticalEdgeClose) {
            l1Left = l1.left;
            l1Top = l2.top;
            l2Left = l2.left;
            l2Top = l1.top;
        } else if (horizontalEdgeClose) {
            l1Left = boundingBox.left + boundingBox.right - l1.right;
            l2Left = boundingBox.left + boundingBox.right - l2.right;
            l1Top = l1.top;
            l2Top = l2.top;
        } else {
            l1Left = l2.left;
            l1Top = l2.top;
            l2Left = l1.left;
            l2Top = l1.top;
        }
        
        return Immutable.List.of(
            { x: l1Left, y: l1Top },
            { x: l2Left, y: l2Top }
        );
    };

    /**
     * Helper function for resize action
     * @private
     * @param {object} bounds
     * @param {{w: number=, h: number=}} size
     * @param {boolean=} proportional
     * @return {{w:number, h: number}} size
     */
    var _calculateNewSize = function (bounds, size, proportional) {
        var newSize = {};
        if (proportional) {
            if (size.hasOwnProperty("w")) {
                newSize.w = size.w;
                newSize.h = newSize.w * (bounds.height / bounds.width);
            } else if (size.hasOwnProperty("h")) {
                newSize.h = size.h;
                newSize.w = newSize.h * (bounds.width / bounds.height);
            } else {
                newSize.w = bounds.width;
                newSize.h = bounds.height;
            }
        } else {
            newSize.w = size.hasOwnProperty("w") ? size.w : bounds.width;
            newSize.h = size.hasOwnProperty("h") ? size.h : bounds.height;
        }
        return newSize;
    };

    /**
     * Helper function that will break down a given layer to all it's children
     * and return layerActionsUtil compatible layer actions to resize all the kids
     * so the overall selection ends with given size
     *
     * @param {Document} document
     * @param {Layer} targetLayer
     * @param {{w: number, h: number}} size
     * @param {Array.<{layer: Layer, w: number, h: number}>} resizeResults payload for updating each layer's bounds
     *
     * @return {Immutable.List<{layer: Layer, playObject: PlayObject}>}
     */
    var _getResizeLayerActions = function (document, targetLayer, size, resizeResults) {
        var overallBounds = document.layers.childBounds(targetLayer),
            documentRef = documentLib.referenceBy.id(document.id),
            resizingLayers;

        if (targetLayer.isArtboard) {
            // We don't want to break down artboards, but just change their bounds
            resizingLayers = Immutable.List.of(targetLayer);
        } else {
            resizingLayers = document.layers.descendants(targetLayer);
        }

        resizeResults = resizeResults || [];

        // Used to calculate the new top/left positions of all layers in relation to top/left
        // of the group
        var overallWidthRatio = size.w ? size.w / overallBounds.width : 0,
            overallHeightRatio = size.h ? size.h / overallBounds.height : 0;

        // We used to pass Photoshop just the width and height, and groups would be resized
        // in the same ratio. However, layers like center aligned text and adjustment layers
        // would not resize correctly and report few extra pixels on the sides.
        // To work around this bug (#577) we compute new bounds for all child layers
        // so that they're resized the way Photoshop would resize them through the entire group
        return resizingLayers.reduce(function (playObjects, layer) {
            if (!layer.bounds || layer.bounds.empty) {
                return playObjects;
            }

            var layerRef = [documentRef, layerLib.referenceBy.id(layer.id)],
                layerTop = layer.bounds.top,
                layerLeft = layer.bounds.left,
                targetSize = {},
                targetPosition = {
                    left: layerLeft,
                    top: layerTop
                },
                widthRatio = layer.bounds.width / overallBounds.width,
                heightRatio = layer.bounds.height / overallBounds.height,
                resizeObj;

            if (size.hasOwnProperty("w")) {
                targetSize.w = size.w * widthRatio;
                targetPosition.left = overallBounds.left + (layerLeft - overallBounds.left) * overallWidthRatio;
            }

            if (size.hasOwnProperty("h")) {
                targetSize.h = size.h * heightRatio;
                targetPosition.top = overallBounds.top + (layerTop - overallBounds.top) * overallHeightRatio;
            }

            var newSize = _calculateNewSize(layer.bounds, targetSize, targetLayer.proportionalScaling),
                newWidth = newSize.w,
                newHeight = newSize.h,
                newLeft = targetPosition.left,
                newTop = targetPosition.top;

            if (layer.isArtboard) {
                var boundingBox = {
                    top: newTop,
                    bottom: newTop + newHeight,
                    left: newLeft,
                    right: newLeft + newWidth
                };

                resizeResults.push({
                    layer: layer,
                    w: newWidth,
                    h: newHeight,
                    x: newLeft,
                    y: newTop
                });

                resizeObj = artboardLib.transform(layerRef, boundingBox);
            } else {
                resizeResults.push({
                    layer: layer,
                    w: newWidth,
                    h: newHeight,
                    x: newLeft,
                    y: newTop
                });

                resizeObj = layerLib.setSize(layerRef, newWidth, newHeight, false, newLeft, newTop);
            }

            return playObjects.push({
                layer: layer,
                playObject: resizeObj
            });
        }, Immutable.List(), this);
    };

    /**
     * Sets the given layers' positions
     * Does this by moving every layer inside the selection by itself
     * @private
     * @param {Document} document Owner document
     * @param {Layer|Immutable.Iterable.<Layer>} layerSpec Either a Layer reference or array of Layers
     * @param {{x: number, y: number}} position New top and left values for each layer
     *
     * @return {Promise}
     */
    var setPositionCommand = function (document, layerSpec, position) {
        layerSpec = layerSpec.filterNot(function (layer) {
            return layer.kind === layer.layerKinds.GROUPEND;
        });

        var payload = {
                documentID: document.id,
                positions: []
            },
            options = {
                historyStateInfo: {
                    name: strings.ACTIONS.SET_LAYER_POSITION,
                    target: documentLib.referenceBy.id(document.id)
                }
            };

        var dispatchPromise = this.dispatchAsync(events.document.history.optimistic.REPOSITION_LAYERS, payload),
            translateLayerActions = layerSpec.reduce(function (actions, layer) {
                var layerActions = _getMoveLayerActions.call(this, document, layer, position, payload.positions);
                return actions.concat(layerActions);
            }, Immutable.List(), this);

        var positionPromise = layerActionsUtil.playLayerActions(document, translateLayerActions, true, options);

        return Promise.join(dispatchPromise, positionPromise);
    };

    /**
     * Swaps the two given layers top-left positions
     *
     * @private
     * @param {Document} document Owner document
     * @param {[<Layer>, <Layer>]} layers An array of two layers
     *
     * @return {Promise}
     */
    var swapLayersCommand = function (document, layers) {
        // validate layers input
        if (layers.size !== 2) {
            throw new Error("Expected two layers");
        }

        // Don't act if one of the layers is an empty bound
        if (layers.every(function (layer) { return layer.kind === layer.layerKinds.GROUPEND; })) {
            return Promise.resolve();
        }

        var newPositions = _calculateSwapLocations(document, layers),
            documentRef = documentLib.referenceBy.id(document.id),
            payload = {
                documentID: document.id,
                positions: []
            },
            layerOneActions = _getMoveLayerActions
                .call(this, document, layers.get(0), newPositions.get(0), payload.positions),
            layerTwoActions = _getMoveLayerActions
                .call(this, document, layers.get(1), newPositions.get(1), payload.positions),
            translateActions = layerOneActions.concat(layerTwoActions);
                
        var dispatchPromise = Promise.bind(this).then(function () {
            this.dispatch(events.document.history.optimistic.REPOSITION_LAYERS, payload);
        });

        // Make sure to show this action as one history state
        var options = {
            historyStateInfo: {
                name: strings.ACTIONS.SWAP_LAYERS,
                target: documentRef
            }
        };

        headlights.logEvent("edit", "layers", "swap_layers");
        var swapPromise = layerActionsUtil.playLayerActions(document, translateActions, true, options);

        return Promise.join(dispatchPromise, swapPromise);
    };

    /**
     * Sets the bounds of currently selected layer group in the given document
     *
     * @param {Document} document Target document to run action in
     * @param {Bounds} oldBounds The original bounding box of selected layers
     * @param {Bounds} newBounds Bounds to transform to
     */
    var setBoundsCommand = function (document, oldBounds, newBounds) {
        var selected = document.layers.selected,
            documentRef = documentLib.referenceBy.id(document.id),
            layerRef = [documentRef, layerLib.referenceBy.current],
            resizeObj;
        
        // Special case for artboards where we only resize the artboard
        if (selected.size === 1 && selected.first().isArtboard) {
            var normalBounds = newBounds.normalize(),
                boundingBox = {
                    top: normalBounds.top,
                    bottom: normalBounds.bottom,
                    left: normalBounds.left,
                    right: normalBounds.right
                };
            resizeObj = artboardLib.transform(layerRef, boundingBox);
        } else {
            var pixelWidth = newBounds.width,
                pixelHeight = newBounds.height,
                pixelTop = newBounds.top,
                pixelLeft = newBounds.left;
            
            resizeObj = layerLib.setSize(layerRef, pixelWidth, pixelHeight, false, pixelLeft, pixelTop);
        }
        // No need for lock/hide/select dance for this because this is only 
        // called from transform overlay
        return descriptor.playObject(resizeObj)
            .bind(this)
            .then(function () {
                var descendants = selected.flatMap(document.layers.descendants, document.layers);

                return this.transfer(layerActions.resetBounds, document, descendants);
            })
            // HACK: Artboard resize fails if it's a no-op, so temporarily, we're catching it here
            .catch(function () {});
    };
    
    /**
     * Sets the bounds of currently selected layer group in the given document
     * without sending a Photoshop command.
     *
     * @param {Document} document Target document to run action in
     * @param {Bounds} newBounds Bounds to transform to
     */
    var setDragBoundsCommand = function (document, newBounds) {
        var layerIDs = collection.pluck(document.layers.selected, "id"),
            pixelWidth = newBounds.width,
            pixelHeight = newBounds.height,
            pixelTop = newBounds.top,
            pixelLeft = newBounds.left;

        if (pixelWidth < 0) {
            pixelWidth = -pixelWidth;
            pixelLeft = pixelLeft - pixelWidth;
        }

        if (pixelHeight < 0) {
            pixelHeight = -pixelHeight;
            pixelTop = pixelTop - pixelHeight;
        }

        var payload = {
            documentID: document.id,
            layerIDs: layerIDs,
            size: { w: pixelWidth, h: pixelHeight },
            position: { top: pixelTop, left: pixelLeft }
        };
        
        return this.dispatchAsync(events.document.LAYER_BOUNDS_CHANGED, payload);
    };
    
    /**
     * Sets the given layers' sizes
     * @private
     * @param {Document} document Owner document
     * @param {Layer|Immutable.Iterable.<Layer>} layerSpec Either a Layer reference or array of Layers
     * @param {w: {number}, h: {number}} size New width and height of the layers
     *
     * @returns {Promise}
     */
    var setSizeCommand = function (document, layerSpec, size) {
        layerSpec = layerSpec.filterNot(function (layer) {
            return layer.kind === layer.layerKinds.GROUPEND ||
                document.layers.strictAncestors(layer)
                .some(function (ancestor) {
                    return layerSpec.contains(ancestor);
                });
        }, this);

        var payload = {
                documentID: document.id,
                sizes: []
            },
            options = {
                paintOptions: _paintOptions,
                historyStateInfo: {
                    name: strings.ACTIONS.SET_LAYER_SIZE,
                    target: documentLib.referenceBy.id(document.id)
                }
            };
        // Document
        var dispatchPromise,
            sizePromise;
        if (layerSpec.isEmpty()) {
            var newSize = _calculateNewSize(document.bounds, size),
                newWidth = newSize.w,
                unitsWidth = unitLib.pixels(newWidth),
                newHeight = newSize.h,
                unitsHeight = unitLib.pixels(newHeight),
                resizeObj = documentLib.resize(unitsWidth, unitsHeight, "left", "top");

            payload.size = newSize;
            
            dispatchPromise = this.dispatchAsync(events.document.history.optimistic.RESIZE_DOCUMENT, payload);
            sizePromise = descriptor.playObject(resizeObj);
        } else {
            var resizeLayerActions = layerSpec.reduce(function (actions, layer) {
                var layerActions = _getResizeLayerActions.call(this, document, layer, size, payload.sizes);
                return actions.concat(layerActions);
            }, Immutable.List(), this);

            dispatchPromise = this.dispatchAsync(events.document.history.optimistic.RESIZE_LAYERS, payload);

            sizePromise = layerActionsUtil.playLayerActions(document, resizeLayerActions, true, options);
        }

        return Promise.join(dispatchPromise, sizePromise);
    };
    
    /**
     * Asks photoshop to flip, either horizontally or vertically.
     * Note: this expects an array of layer models, but it only passes the first layer ref to the adapter
     * which seems to expect a ref to at least one active layer.
     * @private
     * @param {Document} document document model object
     * @param {Immutable.Iterable.<Layer>} layers array of layer models
     * @param {string} axis Either horizontal or vertical
     *
     * @return {Promise}
     */
    var flipCommand = function (document, layers, axis) {
        // validate layers input
        if (layers.isEmpty()) {
            throw new Error("Expected at least one layer");
        }
        
        // Get a representative layer (non background)
        // This is a workaround.  The flip action validates that an active, non-background layer ref
        // is provided, even though this is ignored by the underlying photoshop flip process
        var repLayer = layers.find(function (l) { return !l.isBackground; });
        if (!repLayer) {
            throw new Error("flip was not provided a valid non-background layer");
        }
        
        // build a ref, and call photoshop
        var ref = layerLib.referenceBy.id(repLayer.id),
            flipAction = layerLib.flip(ref, axis),
            options = {
                historyStateInfo: {
                    name: strings.ACTIONS.FLIP_LAYERS,
                    target: documentLib.referenceBy.id(document.id)
                }
            };

        return locking.playWithLockOverride(document, layers, flipAction, options)
            .bind(this)
            .then(function () {
                var descendants = layers.flatMap(document.layers.descendants, document.layers);

                return this.transfer(layerActions.resetBounds, document, descendants);
            });
    };
    
    /**
     * Helper command to flip horizontally
     * @private
     *
     * @param {Document} document document model object
     * @param {Immutable.Iterable.<Layer>} layers array of layer models 
     * @return {Promise}
     */
    var flipXCommand = function (document, layers) {
        return flipCommand.call(this, document, layers, "horizontal");
    };
    
    /**
     * Helper command to flip vertically
     *
     * @private
     * @param {Document} document document model object
     * @param {Immutable.Iterable.<Layer>} layers array of layer models 
     * @return {Promise}
     */
    var flipYCommand = function (document, layers) {
        return flipCommand.call(this, document, layers, "vertical");
    };

    /**
     * Helper command to flip selected layers in the current document horizontally
     *
     * @private
     * @return {Promise}
     */
    var flipXCurrentDocumentCommand = function () {
        var applicationStore = this.flux.store("application"),
            currentDocument = applicationStore.getCurrentDocument(),
            selectedLayers = currentDocument.layers.selected;

        if (!currentDocument) {
            return Promise.resolve();
        }
        
        return this.transfer(flipX, currentDocument, selectedLayers);
    };
    
    /**
     * Helper command to flip selected layers in the current document vertically
     *
     * @private
     * @return {Promise}
     */
    var flipYCurrentDocumentCommand = function () {
        var applicationStore = this.flux.store("application"),
            currentDocument = applicationStore.getCurrentDocument(),
            selectedLayers = currentDocument.layers.selected;

        if (!currentDocument) {
            return Promise.resolve();
        }

        return this.transfer(flipY, currentDocument, selectedLayers);
    };


    /**
     * Asks photoshop to align layers either Left, right or center. (horizontally or vertically).
     *
     * @private
     * @param {Document} document document model object
     * @param {Immutable.Iterable.<Layer>} layers array of layer models
     * @param {string} align either left right top bottom hCenter or vCenter
     * @return {Promise}
     */
    var alignCommand = function (document, layers, align) {
        // validate layers input
        if (layers.isEmpty()) {
            throw new Error("Expected at least one layer");
        }
        
        var repLayer = layers.find(function (l) { return !l.isBackground; });
        if (!repLayer) {
            throw new Error("align was not provided a valid non-background layer");
        }
        // build a ref, and call photoshop
        var ref = layerLib.referenceBy.id(repLayer.id),
            alignAction = layerLib.align(ref, align),
            options = {
                historyStateInfo: {
                    name: strings.ACTIONS.ALIGN_LAYERS,
                    target: documentLib.referenceBy.id(document.id)
                }
            };
        
        
        
        return locking.playWithLockOverride(document, layers, alignAction, options)
            .bind(this)
            .then(function () {
                var descendants = layers.flatMap(document.layers.descendants, document.layers);

                return this.transfer(layerActions.resetBounds, document, descendants);
            });
    };
    
    /**
     * Helper command to align Left
     *
     * @private
     * @param {Document} document document model object
     * @param {Immutable.Iterable.<Layer>} layers array of layer models 
     * @return {Promise}
     */
    var alignLeftCommand = function (document, layers) {
        if (!document && !layers) {
            document = this.flux.store("application").getCurrentDocument();
            layers = document.layers.selected;
        }
        return alignCommand.call(this, document, layers, "left");
    };

    /**
     * Helper command to align right
     *
     * @private
     * @param {Document} document document model object
     * @param {Immutable.Iterable.<Layer>} layers array of layer models 
     * @return {Promise}
     */
    var alignRightCommand = function (document, layers) {
        if (!document && !layers) {
            document = this.flux.store("application").getCurrentDocument();
            layers = document.layers.selected;
        }
        return alignCommand.call(this, document, layers, "right");
    };
    
    /**
     * Helper command to align top
     *
     * @private
     * @param {Document} document document model object
     * @param {Immutable.Iterable.<Layer>} layers array of layer models 
     * @return {Promise}
     */
    var alignTopCommand = function (document, layers) {
        if (!document && !layers) {
            document = this.flux.store("application").getCurrentDocument();
            layers = document.layers.selected;
        }
        return alignCommand.call(this, document, layers, "top");
    };

    /**
     * Helper command to align bottom
     *
     * @private
     * @param {Document} document document model object
     * @param {Immutable.Iterable.<Layer>} layers array of layer models 
     * @return {Promise}
     */
    var alignBottomCommand = function (document, layers) {
        if (!document && !layers) {
            document = this.flux.store("application").getCurrentDocument();
            layers = document.layers.selected;
        }
        return alignCommand.call(this, document, layers, "bottom");
    };

    /**
     * Helper command to align vCenter
     *
     * @private
     * @param {Document} document document model object
     * @param {Immutable.Iterable.<Layer>} layers array of layer models 
     * @return {Promise}
     */
    var alignVCenterCommand = function (document, layers) {
        if (!document && !layers) {
            document = this.flux.store("application").getCurrentDocument();
            layers = document.layers.selected;
        }
        return alignCommand.call(this, document, layers, "vCenter");
    };

    /**
     * Helper command to align hCenter
     *
     * @private
     * @param {Document} document document model object
     * @param {Immutable.Iterable.<Layer>} layers array of layer models 
     * @return {Promise}
     */
    var alignHCenterCommand = function (document, layers) {
        if (!document && !layers) {
            document = this.flux.store("application").getCurrentDocument();
            layers = document.layers.selected;
        }
        return alignCommand.call(this, document, layers, "hCenter");
    };

    /**
     * Asks photoshop to align layers either Left, right or center. (horizontally or vertically).
     *
     * @private
     * @param {Document} document document model object
     * @param {Immutable.Iterable.<Layer>} layers array of layer models
     * @param {string} align either left right top bottom hCenter or vCenter
     * @return {Promise}
     */
    var distributeCommand = function (document, layers, align) {
        // validate layers input
        if (layers.isEmpty()) {
            throw new Error("Expected at least one layer");
        }
        
        var repLayer = layers.find(function (l) { return !l.isBackground; });
        if (!repLayer) {
            throw new Error("distribute was not provided a valid non-background layer");
        }
        // build a ref, and call photoshop
        var ref = layerLib.referenceBy.id(repLayer.id),
            distributeAction = layerLib.distribute(ref, align),
            options = {
                historyStateInfo: {
                    name: strings.ACTIONS.DISTRIBUTE_LAYERS,
                    target: documentLib.referenceBy.id(document.id)
                }
            };
        
        return locking.playWithLockOverride(document, layers, distributeAction, options)
            .bind(this)
            .then(function () {
                var descendants = layers.flatMap(document.layers.descendants, document.layers);

                return this.transfer(layerActions.resetBounds, document, descendants);
            });
    };
    
    /**
     * Helper command to dstribute along the horizontal axis
     *
     * @private
     * @param {Document} document document model object
     * @param {Immutable.Iterable.<Layer>} layers array of layer models 
     * @return {Promise}
     */
    var distributeXCommand = function (document, layers) {
        if (!document && !layers) {
            document = this.flux.store("application").getCurrentDocument();
            layers = document.layers.selected;
        }
        return distributeCommand.call(this, document, layers, "horizontally");
    };

    /**
     * Helper command to dstribute along the horizontal axis
     *
     * @private
     * @param {Document} document document model object
     * @param {Immutable.Iterable.<Layer>} layers array of layer models 
     * @return {Promise}
     */
    var distributeYCommand = function (document, layers) {
        if (!document && !layers) {
            document = this.flux.store("application").getCurrentDocument();
            layers = document.layers.selected;
        }
        return distributeCommand.call(this, document, layers, "vertically");
    };

    /**
     * Set the radius of the rectangle shapes in the given layers of the given
     * document to the given number of pixels. Currently, the command ignores
     * document and layers paramters and acts on the selected layers of the
     * active document.
     * 
     * @param {Document} document
     * @param {Immutable.Iterable.<Layer>} layers
     * @param {number} radius New uniform border radius in pixels
     * @param {boolean} coalesce Whether this history state should be coalesce with the previous one
     */
    var setRadiusCommand = function (document, layers, radius, coalesce) {
        var dispatchPromise = this.dispatchAsync(events.document.history.optimistic.RADII_CHANGED, {
            documentID: document.id,
            layerIDs: collection.pluck(layers, "id"),
            coalesce: coalesce,
            radii: {
                topLeft: radius,
                topRight: radius,
                bottomRight: radius,
                bottomLeft: radius
            }
        });

        var radiusDescriptor = contentLib.setRadius(radius),
            options = {
                paintOptions: _paintOptions,
                historyStateInfo: {
                    name: strings.ACTIONS.SET_RADIUS,
                    target: documentLib.referenceBy.id(document.id),
                    coalesce: !!coalesce,
                    suppressHistoryStateNotification: !!coalesce
                }
            },
            radiusPromise = locking.playWithLockOverride(document, layers, radiusDescriptor, options);

        return Promise.join(dispatchPromise, radiusPromise);
    };

    /**
     * Helper command to swap the two given layers top-left positions
     *
     * @private
     *
     * @return {Promise}
     */
    var swapLayersCurrentDocumentCommand = function () {
        var applicationStore = this.flux.store("application"),
            currentDocument = applicationStore.getCurrentDocument(),
            selectedLayers = currentDocument.layers.selected;

        if (!currentDocument ||
            selectedLayers.size !== 2) {
            return Promise.resolve();
        }
        return this.transfer(swapLayers, currentDocument, selectedLayers);
    };

    /**
     * Rotates the currently selected layers by given angle
     *
     * @param {Document} document 
     * @param {number} angle Angle in degrees
     * @return {Promise}
     */
    var rotateCommand = function (document, angle) {
        var documentRef = documentLib.referenceBy.id(document.id),
            layerRef = [documentRef, layerLib.referenceBy.current],
            rotateObj = layerLib.rotate(layerRef, angle),
            options = {
                historyStateInfo: {
                    name: strings.ACTIONS.ROTATE_LAYERS,
                    target: documentLib.referenceBy.id(document.id)
                }
            };

        return locking.playWithLockOverride(document, document.layers.selected, rotateObj, options)
            .bind(this)
            .then(function () {
                var selected = document.layers.selected,
                    descendants = selected.flatMap(document.layers.descendants, document.layers);

                return this.transfer(layerActions.resetBounds, document, descendants);
            });
    };

    /**
     * Helper command to rotate layers in currently selected document through the menu
     *
     * @param  {{angle: number}} payload Contains the angle to rotate layers by
     * @return {Promise}
     */
    var rotateLayersInCurrentDocumentCommand = function (payload) {
        if (!payload.hasOwnProperty("angle")) {
            log.error("Missing angle");
            return Promise.resolve();
        }

        var applicationStore = this.flux.store("application"),
            currentDocument = applicationStore.getCurrentDocument();

        if (!currentDocument) {
            return Promise.resolve();
        }

        var angle = payload.angle;

        return this.transfer(rotate, currentDocument, angle);
    };

    /**
     * Nudges the given layers in the given direction
     * @private
     * @param {string} direction Direction of nudge
     * @param {boolean} bigStep Flag to indicate bigger nudge
     *
     * @return {Promise}
     */
    var nudgeLayersCommand = function (direction, bigStep) {
        // Different from other actions, nudge always makes sure to get the latest document model
        // Since we rely on the bounds information from the model to compute new positions
        // Otherwise, superselectTool.onKeyDown's document model and the current document model
        // can fall out of sync and produce false results, breaking parity
        var document = this.flux.store("application").getCurrentDocument(),
            layerSpec = document.layers.selected;

        if (layerSpec.isEmpty()) {
            return Promise.resolve();
        }

        var hasLocked = layerSpec.some(function (layer) {
            return layer.locked;
        });

        if (hasLocked) {
            return Promise.resolve();
        }

        layerSpec = layerSpec.filterNot(function (layer) {
            return layer.kind === layer.layerKinds.GROUPEND;
        });

        var options = {
                historyStateInfo: {
                    name: strings.ACTIONS.NUDGE_LAYERS,
                    target: documentLib.referenceBy.id(document.id)
                }
            },
            payload = {
                documentID: document.id,
                positions: []
            },
            deltaX = 0,
            deltaY = 0,
            bigNudge = 10,
            nudge = 1;

        switch (direction) {
            case "up":
                deltaY = bigStep ? -bigNudge : -nudge;
                break;
            case "down":
                deltaY = bigStep ? bigNudge : nudge;
                break;
            case "left":
                deltaX = bigStep ? -bigNudge : -nudge;
                break;
            case "right":
                deltaX = bigStep ? bigNudge : nudge;
                break;
        }

        var translateLayerActions = layerSpec.reduce(function (actions, layer) {
            var currentBounds = document.layers.childBounds(layer),
                position = {
                    x: currentBounds.left + deltaX,
                    y: currentBounds.top + deltaY
                },
                layerActions = _getMoveLayerActions.call(this, document, layer, position, payload.positions);

            return actions.concat(layerActions);
        }, Immutable.List(), this);

        var dispatchPromise = this.dispatchAsync(events.document.history.optimistic.REPOSITION_LAYERS, payload),
            positionPromise = layerActionsUtil.playLayerActions(document, translateLayerActions, true, options);
        
        return Promise.join(positionPromise, dispatchPromise);
    };

    var beforeStartupCommand = function () {
        var _transformHandler = function () {
            this.dispatch(events.ui.TOGGLE_OVERLAYS, { enabled: true });
            
            // Since finishing the click, the selected layers may have changed, so we'll get
            // the most current document model before proceeding.
            var appStore = this.flux.store("application"),
                nextDoc = appStore.getCurrentDocument();

            // FIXME: We used to listen to "move" event's translation and optimistically update
            // all selected layers, but due to a recent bug, "move" event sends us the displacement
            // of layers from the changing (0,0) coordinates, which causes bugs like
            // getting (650,0) when the move was actually (-100, 0) for a 750 px wide layer
            this.flux.actions.layers.resetBounds(nextDoc, nextDoc.layers.allSelected);
        }.bind(this);

        descriptor.addListener("transform", _transformHandler);
        return Promise.resolve();
    };

    /**
     * Action to set Position
     * @type {Action}
     */
    var setPosition = {
        command: setPositionCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action to set Size
     * @type {Action}
     */
    var setSize = {
        command: setSizeCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action to set Size
     * @type {Action}
     */
    var setBounds = {
        command: setBoundsCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };
    
    /**
    * Action to set Size
    * @type {Action}
    */
    var setDragBounds = {
        command: setDragBoundsCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action to flip horizontally
     * @type {Action}
     */
    var flipX = {
        command: flipXCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action to flip vertically
     * @type {Action}
     */
    var flipY = {
        command: flipYCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };
    
    /**
     * Action to align left
     * @type {Action}
     */
    var alignLeft = {
        command: alignLeftCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action to align right
     * @type {Action}
     */
    var alignRight = {
        command: alignRightCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };
    /**
     * Action to align top
     * @type {Action}
     */
    var alignTop = {
        command: alignTopCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };
    /**
     * Action to align bottom
     * @type {Action}
     */
    var alignBottom = {
        command: alignBottomCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action to align HCenter
     * @type {Action}
     */
    var alignHCenter = {
        command: alignHCenterCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action to align VCenter
     * @type {Action}
     */
    var alignVCenter = {
        command: alignVCenterCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action to distribute Horizontally
     * @type {Action}
     */
    var distributeX = {
        command: distributeXCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action to distribute Vetrically
     * @type {Action}
     */
    var distributeY = {
        command: distributeYCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };


    /**
     * Action to flip the current document's selected layers horizontally
     * @type {Action}
     */
    var flipXCurrentDocument = {
        command: flipXCurrentDocumentCommand,
        reads: [locks.PS_DOC, locks.JS_DOC, locks.JS_APP],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action to flip the current document's selected layers vertically
     * @type {Action}
     */
    var flipYCurrentDocument = {
        command: flipYCurrentDocumentCommand,
        reads: [locks.PS_DOC, locks.JS_DOC, locks.JS_APP],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action to swap two selected layers
     * @type {Action}
     */
    var swapLayers = {
        command: swapLayersCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action to swap the two selected layers top-left positions in the current document
     * @type {Action}
     */
    var swapLayersCurrentDocument = {
        command: swapLayersCurrentDocumentCommand,
        reads: [locks.PS_DOC, locks.JS_DOC, locks.JS_APP],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action to the set the border radius of a rectangle shape layer
     * @type {Action}
     */
    var setRadius = {
        command: setRadiusCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action to set the rotation angle of current layer
     * @type {Action}
     */
    var rotate = {
        command: rotateCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action that rotates all selected layers a certain degree
     * @type {Action}
     */
    var rotateLayersInCurrentDocument = {
        command: rotateLayersInCurrentDocumentCommand,
        reads: [locks.PS_DOC, locks.JS_DOC, locks.JS_APP],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var nudgeLayers = {
        command: nudgeLayersCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var beforeStartup = {
        command: beforeStartupCommand,
        reads: [],
        writes: []
    };

    exports.beforeStartup = beforeStartup;


    exports.setPosition = setPosition;
    exports.setSize = setSize;
    exports.setDragBounds = setDragBounds;
    exports.flipX = flipX;
    exports.flipY = flipY;
    exports.flipXCurrentDocument = flipXCurrentDocument;
    exports.flipYCurrentDocument = flipYCurrentDocument;
    exports.alignLeft = alignLeft;
    exports.alignRight = alignRight;
    exports.alignTop = alignTop;
    exports.alignBottom = alignBottom;
    exports.alignVCenter = alignVCenter;
    exports.alignHCenter = alignHCenter;
    exports.distributeY = distributeY;
    exports.distributeX = distributeX;
    exports.swapLayers = swapLayers;
    exports.swapLayersCurrentDocument = swapLayersCurrentDocument;
    exports.setRadius = setRadius;
    exports.setBounds = setBounds;
    exports.rotate = rotate;
    exports.rotateLayersInCurrentDocument = rotateLayersInCurrentDocument;
    exports.nudgeLayers = nudgeLayers;
});
