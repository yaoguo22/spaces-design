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

    var d3 = require("d3"),
        Immutable = require("immutable");

    var system = require("js/util/system");

    /**
     * MouseEvent.which value for left mouse button
     * @type {Number}
     */
    var LEFT_MOUSE_BUTTON = 1;

    /**
     * Creates the D3 model
     *
     * @param {Element} el svg element to draw in
     * @param {Flux} flux object so we have access to our stores and actions 
     */
    var TransformScrim = function (el, flux) {
        this._flux = flux;
        this._dragging = false;
        var transformGroup = d3.select(el);

        transformGroup.append("g")
            .classed("transform-control-group", true);

        transformGroup.append("g")
            .classed("selection-bounds", true);

        transformGroup.append("g")
            .classed("rotation-compass", true);
    };

    /**
     * Given an array of bounds, prepares data points for D3 to use on rendering
     *
     * @param {Array.<Bounds>} allBounds Array of bounds to map to data
     * @return {Array.<Array.<object>>} An array of arrays of points for each bounds
     */
    TransformScrim.prototype._buildBoundsData = function (allBounds) {
        // HACK: For some reason Photoshop's bounds seem to be shifted by ~1px to the
        // bottom-right. See https://github.com/adobe-photoshop/spaces-design/issues/866
        var offset = system.isMac ? 0 : this._scale;

        return allBounds.map(function (bounds) {
            // Short circuit layers with empty bounds
            if (!bounds || (bounds.width === 0 && bounds.height === 0)) {
                return [];
            }

            return [
                { x: bounds.left + offset, y: bounds.top + offset, key: "nw" },
                { x: bounds.left + offset + bounds.width / 2, y: bounds.top + offset, key: "n" },
                { x: bounds.right + offset, y: bounds.top + offset, key: "ne" },
                { x: bounds.right + offset, y: bounds.top + offset + bounds.height / 2, key: "e" },
                { x: bounds.right + offset, y: bounds.bottom + offset, key: "se" },
                { x: bounds.left + offset + bounds.width / 2, y: bounds.bottom + offset, key: "s" },
                { x: bounds.left + offset, y: bounds.bottom + offset, key: "sw" },
                { x: bounds.left + offset, y: bounds.top + offset + bounds.height / 2, key: "w" }
            ];
        });
    };

    /**
     * Updates the D3 model
     *
     * @param {Element} el Owner SVG Element
     * @param {object} state React Component state
     * @param {boolean=} force If true, will redraw regardless of dragging state
     */
    TransformScrim.prototype.update = function (el, state, force) {
        if (this._dragging && !force) {
            return;
        }

        var scrim = d3.select(el);

        // We calculate the reverse scale here to draw the stroke width and rotate areas
        // at correct size no matter the zoom level
        var transformObj = d3.transform(d3.select(el).attr("transform"));
        this._scale = 1 / transformObj.scale[0];
        
        // Resets the transform of the anchors/bound
        scrim.selectAll(".transform-control-group")
            .attr("transform", null);

        scrim.selectAll(".anchor-points").remove();
        scrim.selectAll(".rotate-areas").remove();
        scrim.selectAll(".selection-bounds").remove();
        scrim.selectAll(".selection-parent-bounds").remove();

        if (!state.bounds || state.hidden) {
            return;
        }
        
        this._oldBounds = this._bounds;
        this._bounds = state.bounds;
        this._el = el;

        var data = this._buildBoundsData([this._bounds.normalize()])[0];

        // Don't draw parent Bounds while resizing / rotating
        if (state.parentBounds) {
            var parentData = this._buildBoundsData(state.parentBounds);
       
            this._drawParentBounds(parentData);
        }

        // Have to do them in this order so z-order is right
        if (!state.noRotation) {
            this._drawRotationCorners(data);
        }

        this._drawSelectionBounds(data);
        
        if (!state.noResize) {
            this._drawResizeAnchors(data);
        }
    };

    /**
     * Removes the D3 model
     *
     * @param {Element} el Owner SVG element
     */
    TransformScrim.prototype.destroy = function (el) {
        d3.select(el).selectAll(".transform-control-group").remove();
    };

    TransformScrim.prototype.clear = function (el) {
        d3.select(el).selectAll(".transform-control-group").selectAll("*").remove();
    };

    /**
     * Resizing helper function, saves the initial bounds
     *
     * @private
     */
    TransformScrim.prototype._startResizing = function (d) {
        if (d3.event.sourceEvent.which !== LEFT_MOUSE_BUTTON) {
            return;
        }
        this._dragging = true;
        this._dragCorner = d.key;
        
        this._initialBounds = this._bounds;
        this._quadrantBounds = this._bounds;
    };

    /**
     * Rotation helper function, we compute the center of the bounds here, and
     * the angle from the current anchor to center so calculating the offset is
     * easier.
     * 
     * @private
     * @param {object} d Data point that initiated rotate, we calculate initial angle using that
     */
    TransformScrim.prototype._startRotating = function (d) {
        if (d3.event.sourceEvent.which !== LEFT_MOUSE_BUTTON) {
            return;
        }
        this._dragging = true;
        d3.select(this._el).selectAll(".selection-parent-bounds").remove();
        d3.select("#" + d.key + "-resize")
            .classed("anchor-dragging", true);
        
        this._initialBounds = this._bounds;
        this._currentAngle = 0;
        this._initialAngle = Math.atan2(d.y - this._initialBounds.yCenter,
            d.x - this._initialBounds.xCenter) * 180 / Math.PI;
    };

    /**
     * Rotation helper function, calculate the new angle offset, and transforms the controls
     * to show user end result of rotation without applying it
     *
     * @private
     */
    TransformScrim.prototype._rotateBounds = function () {
        if (!this._dragging) {
            return;
        }
        var inSteps = d3.event.sourceEvent.shiftKey,
            xDiff = d3.event.x - this._initialBounds.xCenter,
            yDiff = d3.event.y - this._initialBounds.yCenter,
            angleChange = Math.atan2(yDiff, xDiff) * 180 / Math.PI,
            // Add the change to last angle, and subtract from initial angle to find how much we're rotating
            degreeAngle = (this._currentAngle + angleChange - this._initialAngle) % 360;

        if (inSteps) {
            degreeAngle = Math.round(degreeAngle / 45) * 45;
        }

        // Get rid of -0 so transform renders correctly for 2PI
        degreeAngle = degreeAngle === -0 ? 0 : degreeAngle;

        this._currentAngle = degreeAngle;

        var transformString = "rotate(" +
                degreeAngle + " " +
                this._initialBounds.xCenter + "," +
                this._initialBounds.yCenter + ")";

        d3.select(this._el).selectAll(".transform-control-group")
            .attr("transform", transformString);

        this._drawCompass(degreeAngle);
    };

    /**
     * Given the corner being dragged and initial bounds
     * Calculates the new bounds without any modifiers applied
     *
     * @param {string} corner 
     *
     * @return {Bounds} Bounds as result of the corner dragged
     */
    TransformScrim.prototype._simpleDragBounds = function (corner) {
        // Reset the bounds
        var bounds = this._initialBounds;
        
        // Update the correct corner to the new mouse location
        switch (corner) {
        case "nw":
            bounds = this._initialBounds.merge({
                left: d3.event.x,
                top: d3.event.y
            });
            break;
        case "n":
            bounds = this._initialBounds.set("top", d3.event.y);
            break;
        case "ne":
            bounds = this._initialBounds.merge({
                right: d3.event.x,
                top: d3.event.y
            });
            break;
        case "e":
            bounds = this._initialBounds.set("right", d3.event.x);
            break;
        case "se":
            bounds = this._initialBounds.merge({
                right: d3.event.x,
                bottom: d3.event.y
            });
            break;
        case "s":
            bounds = this._initialBounds.set("bottom", d3.event.y);
            break;
        case "sw":
            bounds = this._initialBounds.merge({
                left: d3.event.x,
                bottom: d3.event.y
            });
            break;
        case "w":
            bounds = this._initialBounds.set("left", d3.event.x);
            break;
        }

        return bounds;
    };

    /**
     * Updates which drag corner should be highlighted given the current 
     * drag bounds
     *
     * @param {Bounds} bounds Current drag bounds
     * @param {boolean} mirrorOnEdge Flag for mirroring, will calculate based on center of initial bounds
     */
    TransformScrim.prototype._updateDragCorner = function (bounds, mirrorOnEdge) {
        var tempBounds = bounds.normalize(),
            compareBounds;

        // If we're mirroring, we compare the center of initial bounds to mouse location
        if (mirrorOnEdge) {
            compareBounds = {
                left: this._initialBounds.xCenter,
                right: this._initialBounds.xCenter,
                top: this._initialBounds.yCenter,
                bottom: this._initialBounds.yCenter
            };

            if (d3.event.x >= compareBounds.right) {
                this._dragCorner = this._dragCorner.replace("w", "e");
            }

            if (d3.event.x <= compareBounds.right) {
                this._dragCorner = this._dragCorner.replace("e", "w");
            }

            if (d3.event.y >= compareBounds.bottom) {
                this._dragCorner = this._dragCorner.replace("n", "s");
            }

            if (d3.event.y <= compareBounds.bottom) {
                this._dragCorner = this._dragCorner.replace("s", "n");
            }
        } else {
            compareBounds = this._quadrantBounds;

            // If left edge passes over right edge: w => e
            if (tempBounds.left >= compareBounds.right) {
                this._dragCorner = this._dragCorner.replace("w", "e");
                this._quadrantBounds = this._quadrantBounds.merge({
                    left: this._quadrantBounds.right,
                    right: this._quadrantBounds.right + this._quadrantBounds.width
                });
            }

            // If right edge passes over left edge: e => w
            if (tempBounds.right <= compareBounds.left) {
                this._dragCorner = this._dragCorner.replace("e", "w");
                this._quadrantBounds = this._quadrantBounds.merge({
                    right: this._quadrantBounds.left,
                    left: this._quadrantBounds.left - this._quadrantBounds.width
                });
            }

            // If top edge passes over bottom edge: n => s
            if (tempBounds.top >= compareBounds.bottom) {
                this._dragCorner = this._dragCorner.replace("n", "s");
                this._quadrantBounds = this._quadrantBounds.merge({
                    top: this._quadrantBounds.bottom,
                    bottom: this._quadrantBounds.bottom + this._quadrantBounds.height
                });
            }

            // If bottom edge passes over top edge: s => n
            if (tempBounds.bottom <= compareBounds.top) {
                this._dragCorner = this._dragCorner.replace("s", "n");
                this._quadrantBounds = this._quadrantBounds.merge({
                    bottom: this._quadrantBounds.top,
                    top: this._quadrantBounds.top - this._quadrantBounds.height
                });
            }
        }
    };

    /**
     * Given the two modifiers (proportional and/or mirror on edge)
     * will calculate the new bounds during drag resize
     *
     * @param {Bounds} bounds Unmodified bounds as result of drag
     * @param {string} corner Corner being dragged
     * @param {boolean} proportional Flag to keep width and height ratio constant
     * @param {boolean} mirrorOnEdge Flag to resize in relation to the center and mirror on the counter edge
     *
     * @return {Bounds} modified bounds as the result of the drag operation
     */
    TransformScrim.prototype._calculateModifiedBounds = function (bounds, corner, proportional, mirrorOnEdge) {
        // Short circuit the function if nothing will change
        if (!proportional && !mirrorOnEdge) {
            return bounds;
        }
 
        var nextWidth = bounds.width,
            nextHeight = bounds.height,
            heightDifference = 0,
            widthDifference = 0,
            modifiedBounds = bounds;

        // Calculate ratio if proportional
        if (proportional) {
            switch (corner) {
                // For sides, we grow the two other sides equally keeping the ratio same
                case "n":
                case "e":
                case "s":
                case "w":
                    var ratio = 0;

                    if (corner === "n" || corner === "s") {
                        ratio = bounds.height / this._initialBounds.height;
                        nextWidth = this._initialBounds.width * ratio;
                    } else if (corner === "e" || corner === "w") {
                        ratio = bounds.width / this._initialBounds.width;
                        nextHeight = this._initialBounds.height * ratio;
                    }
                    break;

                // For corners, we find the smaller size and limit resizing to that
                case "nw":
                case "ne":
                case "se":
                case "sw":
                    var widthRatio = bounds.width / this._initialBounds.width,
                        heightRatio = bounds.height / this._initialBounds.height,
                        diagonal = this._initialBounds.width / this._initialBounds.height;

                    // If we're mirroring on the edge, we ignore the signs
                    var multiplier = mirrorOnEdge ? 1 :
                        Math.sign(heightRatio) * Math.sign(widthRatio);

                    // Using the signs of original ratios help us figure out four quadrant resizing
                    if (heightRatio < widthRatio) {
                        nextWidth = multiplier * bounds.height * diagonal;
                    } else {
                        nextHeight = multiplier * bounds.width / diagonal;
                    }
                    break;
            }
        }

        heightDifference = nextHeight - this._initialBounds.height;
        widthDifference = nextWidth - this._initialBounds.width;

        // For each corner calculate the new bounds
        switch (corner) {
            case "nw":
                if (proportional) {
                    modifiedBounds = modifiedBounds.merge({
                        left: modifiedBounds.right - nextWidth,
                        top: modifiedBounds.bottom - nextHeight
                    });
                }
                
                if (mirrorOnEdge) {
                    modifiedBounds = modifiedBounds.merge({
                        bottom: modifiedBounds.bottom + heightDifference,
                        right: modifiedBounds.right + widthDifference
                    });
                }
                break;
            case "n":
                if (proportional) {
                    modifiedBounds = modifiedBounds.merge({
                        left: modifiedBounds.left - widthDifference / 2,
                        right: modifiedBounds.right + widthDifference / 2
                    });
                }

                if (mirrorOnEdge) {
                    modifiedBounds = modifiedBounds.set("bottom", this._initialBounds.bottom + heightDifference);
                }
                break;
            case "ne":
                if (proportional) {
                    modifiedBounds = modifiedBounds.merge({
                        right: modifiedBounds.left + nextWidth,
                        top: modifiedBounds.bottom - nextHeight
                    });
                }
                
                if (mirrorOnEdge) {
                    modifiedBounds = modifiedBounds.merge({
                        bottom: modifiedBounds.bottom + heightDifference,
                        left: modifiedBounds.left - widthDifference
                    });
                }
                break;
            case "e":
                if (proportional) {
                    modifiedBounds = modifiedBounds.merge({
                        top: modifiedBounds.top - heightDifference / 2,
                        bottom: modifiedBounds.bottom + heightDifference / 2
                    });
                }
                
                if (mirrorOnEdge) {
                    modifiedBounds = modifiedBounds.set("left", this._initialBounds.left - widthDifference);
                }
                break;
            case "se":
                if (proportional) {
                    modifiedBounds = modifiedBounds.merge({
                        right: modifiedBounds.left + nextWidth,
                        bottom: modifiedBounds.top + nextHeight
                    });
                }
                
                if (mirrorOnEdge) {
                    modifiedBounds = modifiedBounds.merge({
                        top: modifiedBounds.top - heightDifference,
                        left: modifiedBounds.left - widthDifference
                    });
                }
                break;
            case "s":
                if (proportional) {
                    modifiedBounds = modifiedBounds.merge({
                        left: modifiedBounds.left - widthDifference / 2,
                        right: modifiedBounds.right + widthDifference / 2
                    });
                }
                
                if (mirrorOnEdge) {
                    modifiedBounds = modifiedBounds.set("top", this._initialBounds.top - heightDifference);
                }
                break;
            case "sw":
                if (proportional) {
                    modifiedBounds = modifiedBounds.merge({
                        left: modifiedBounds.right - nextWidth,
                        bottom: modifiedBounds.top + nextHeight
                    });
                }
                
                if (mirrorOnEdge) {
                    modifiedBounds = modifiedBounds.merge({
                        top: modifiedBounds.top - heightDifference,
                        right: modifiedBounds.right + widthDifference
                    });
                }
                break;
            case "w":
                if (proportional) {
                    modifiedBounds = modifiedBounds.merge({
                        top: modifiedBounds.top - heightDifference / 2,
                        bottom: modifiedBounds.bottom + heightDifference / 2
                    });
                }
                
                if (mirrorOnEdge) {
                    modifiedBounds = modifiedBounds.set("right", this._initialBounds.right + widthDifference);
                }
                break;
        }
        
        return modifiedBounds;
    };

    /**
     * Resize helper function, calculate the new bounds on drag resizing and updates local bound object
     *
     * @private
     * @param {object} d Data point drag was started on, used for it's key
     */
    TransformScrim.prototype._resizeBounds = function (d) {
        if (!this._dragging) {
            return;
        }
        var currentDocument = this._flux.store("application").getCurrentDocument(),
            layers = currentDocument.layers.selected,
            anyLayersProportional = layers.some(function (layer) {
                return layer.proportionalScaling;
            });

        var proportional = d3.event.sourceEvent.shiftKey || anyLayersProportional,
            mirrorOnEdge = d3.event.sourceEvent.altKey;

        // First calculate the new bounds without any modifiers
        var bounds = this._simpleDragBounds(d.key);
        
        // Given the new bounds, update drag corner
        this._updateDragCorner(bounds, mirrorOnEdge);

        // Given the modifiers, calculate the new bounds
        var modifiedBounds = this._calculateModifiedBounds(bounds, d.key, proportional, mirrorOnEdge);

        // Updates the models without talking to Photoshop
        var applicationStore = this._flux.store("application"),
            document = applicationStore.getCurrentDocument(),
            selectedLayers = document ? document.layers.selected : Immutable.List(),
            isGroup = selectedLayers.some(function (layer) {
                return layer.kind === layer.layerKinds.GROUP;
            });
        
        if (!isGroup) {
            this._flux.actions.transform.setDragBoundsThrottled(document, modifiedBounds);
        }

        // Update the on-screen bounds
        this.update(this._el, { bounds: modifiedBounds }, true);
    };

    /**
     * Rotation helper to clean up, also calls the apply function on parent
     *
     * @private
     */
    TransformScrim.prototype._finishRotating = function (d) {
        if (!this._dragging) {
            return;
        }
        
        this._dragging = false;
        this._initialBounds = null;
        this._initialAngle = 0;

        d3.select("#" + d.key + "-resize")
            .classed("anchor-dragging", false);

        d3.select(this._el).selectAll(".rotation-compass-part").remove();

        var applicationStore = this._flux.store("application"),
            document = applicationStore.getCurrentDocument();
            
        this._flux.actions.transform.rotate(document, this._currentAngle);

        this._currentAngle = 0;
        this._dragCorner = null;
    };

    /**
     * Resize helper to clean up, also calls the apply function on parent
     *
     * @private
     */
    TransformScrim.prototype._finishResizing = function () {
        if (!this._dragging) {
            return;
        }
        
        // Remove anchor highlight
        d3.select("#" + this._dragCorner + "-resize")
            .classed("anchor-dragging", false);
                
        this._dragging = false;
        this._initialBounds = null;
        this._quadrantBounds = null;
        this._dragCorner = null;

        var applicationStore = this._flux.store("application"),
            document = applicationStore.getCurrentDocument();

        this._flux.actions.transform.setBounds(document, this._oldBounds, this._bounds);
    };


    /**
     * Draws the rotation areas on four corners of the bounds
     * 
     * @private
     * @param {Array.<object>} data Data list containing corners
     */
    TransformScrim.prototype._drawRotationCorners = function (data) {
        var g = d3.select(this._el).selectAll(".transform-control-group"),
            anchor = g.selectAll(".rotate-anchor")
                // Attaches data to the rotation anchors
                .data(data, function (d) { return d.key; }),
            scale = this._scale;

        // Defines the rotation behavior
        var dragRotate = d3.behavior.drag()
            .origin(function (d) { return d; })
            .on("dragstart", this._startRotating.bind(this))
            .on("drag", this._rotateBounds.bind(this))
            .on("dragend", this._finishRotating.bind(this));

        // Defines the size variables for the SVG being drawn
            
        var rem = this._flux.store("ui").getRootSize(),
            innerRadius = 0.25 * rem,
            outerRadius = 1 * rem;

        // Defines a d3 arc object given the data object
        var makeArc = function (d) {
            // Calculate angle as quadrants, then multiply by 90 degrees
            // 0 is North, 1 is East etc.
            var startAngle, endAngle;

            switch (d.key) {
            case "nw":
                startAngle = 3;
                endAngle = 4;
                break;
            case "ne":
                startAngle = 0;
                endAngle = 1;
                break;
            case "se":
                startAngle = 1;
                endAngle = 2;
                break;
            case "sw":
                startAngle = 2;
                endAngle = 3;
                break;
            default:
                startAngle = 0;
                endAngle = 0;
            }

            startAngle = startAngle * Math.PI / 2;
            endAngle = endAngle * Math.PI / 2;

            var arcFn = d3.svg.arc()
                .innerRadius(innerRadius * scale)
                .outerRadius(outerRadius * scale)
                .startAngle(startAngle)
                .endAngle(endAngle);
            
            return arcFn(d);
        };


        // Dive into the anchor selector and for each point, append a SVG arc shape
        anchor.enter()
            .append("path")
            .classed("rotate-areas", true)
            .attr("d", function (d) { return makeArc(d); })
            .attr("id", function (d) { return d.key + "-rotate";})
            // Make sure arcs we drew are on four corners
            .attr("transform", function (d) {
                return "translate(" + d.x + "," + d.y + ")";
            })
            // Hover behavior
            .on("mouseover", function () {
                d3.select(this)
                    .classed("rotate-area-hover", true);
            })
            // Mouse out behavior
            .on("mouseout", function () {
                d3.select(this)
                    .classed("rotate-area-hover", false);
            })
            // Prevents mouse clicks from being sent down
            .on("mousedown", function () {
                d3.event.stopPropagation();
            })
            // Attach the drag behavior
            .call(dragRotate);
        
        // Gets us out of the anchor data set and lets d3 know it's ok to draw
        anchor.exit()
            .remove();
    };

    /**
     * Draws a different classed bounds around immediate parents of selected layers
     *
     * @private
     * @param {Immutable.List.<object>} data Data list containing corner points for each bound
     */
    TransformScrim.prototype._drawParentBounds = function (data) {
        var g = d3.select(this._el).selectAll(".transform-control-group"),
            bounds = g.selectAll(".parent-bounds")
                .data(data.toArray()),
            strokeWidth = 1;

        bounds.enter()
            .append("polygon")
                .attr("points", function (d) {
                    return d.map(function (p) {
                        return [p.x, p.y].join(",");
                    }).join(" ");
                })
                .classed("selection-parent-bounds", true)
                // We style the stroke width here so we can scale it correctly
                .style("stroke-width", strokeWidth * this._scale)
                // Lets pointer events fall through to other SVG shapes
                .style("pointer-events", "none");
                
        bounds.exit()
            .remove();
    };

    /**
     * Draws the bounds around the selection
     *
     * @private
     * @param {Array.<object>} data Data list containing corners
     */
    TransformScrim.prototype._drawSelectionBounds = function (data) {
        var g = d3.select(this._el).selectAll(".transform-control-group"),
            bounds = g.selectAll(".transform-bounds")
                .data([data]),
            strokeWidth = 1.5;

        // Maps all given points to a polygon anchor
        bounds.enter()
            .append("polygon")
                .attr("points", function (d) {
                    return d.map(function (p) {
                        return [p.x, p.y].join(",");
                    }).join(" ");
                })
                .classed("selection-bounds", true)
                // We style the stroke width here so we can scale it correctly
                .style("stroke-width", strokeWidth * this._scale)
                // Lets pointer events fall through to other SVG shapes
                .style("pointer-events", "none");

        bounds.exit()
            .remove();
    };

    /**
     * Draws the resize anchors, on all 8 directions
     *
     * @private
     * @param {Array.<object>} data Data list containing corners
     */
    TransformScrim.prototype._drawResizeAnchors = function (data) {
        var g = d3.select(this._el).selectAll(".transform-control-group"),
            anchor = g.selectAll(".transform-anchor")
                .data(data, function (d) { return d.key; }),
            scale = this._scale,
            dragCorner = this._dragCorner;

        // Define all size variables here
        var rem = this._flux.store("ui").getRootSize(),
            anchorRadius = 0.35 * rem,
            hoverRadius = 0.5 * rem,
            strokeWidth = 1.0;

        // Define the drag behavior here
        var dragResize = d3.behavior.drag()
            .origin(function (d) { return d; })
            .on("dragstart", this._startResizing.bind(this))
            .on("drag", this._resizeBounds.bind(this))
            .on("dragend", this._finishResizing.bind(this));
            
        anchor.enter()
            // Draw a rectangle for each data point
            .append("circle")
            .classed("anchor-points", true)
            .classed("anchor-dragging", function (d) { return d.key === dragCorner; })
            .attr("id", function (d) { return d.key + "-resize";})
            .attr("cx", function (d) { return d.x; })
            .attr("cy", function (d) { return d.y; })
            .attr("r", anchorRadius * scale)
            // Set the stroke width style here so we can scale
            .style("stroke-width", strokeWidth * scale)
            // Sets the HTML cursor for each anchor
            .style("cursor", function (d) { return d.key + "-resize"; })
            // Sets the class on mouse over
            .on("mouseover", function () {
                d3.select(this)
                    .attr("r", hoverRadius * scale)
                    .classed("anchor-hover", true);
            })
            // Resets the class on mouse over
            .on("mouseout", function () {
                d3.select(this)
                    .attr("r", anchorRadius * scale)
                    .classed("anchor-hover", false);
            })
            // Stops the mouse event from being sent to other SVG shapes
            .on("mousedown", function () {
                d3.event.stopPropagation();
            })
            // Define anchor behavior for drag
            .call(dragResize);
        
        anchor.exit()
            .remove();
    };

    /**
     * Draws a compass at the center of the layer during rotation
     * @private
     * @param {Number} angle Angle of rotation in degrees
     */
    TransformScrim.prototype._drawCompass = function (angle) {
        var g = d3.select(this._el).selectAll(".rotation-compass"),
            transformString = "rotate(" + angle + " " +
                this._initialBounds.xCenter + " " +
                this._initialBounds.yCenter + ")",
            scale = this._scale,
            xCenter = this._initialBounds.xCenter,
            yCenter = this._initialBounds.yCenter;

        g.selectAll(".rotation-compass-part").remove();

        var rem = this._flux.store("ui").getRootSize(),
            strokeWidth = 1.0,
            // How far the arc is from the center
            // And how big the compass circle is
            arcRadius = 2.083 * rem,
            // How far the line sticks out the sides
            sideStickOut = 0.833 * rem,
            // How long the up down tails at the center are
            centerVertical = 0.833 * rem,
            // How big the center point circle is
            centerRadius = 0.417 * rem;

        var makeArc = d3.svg.arc()
            .innerRadius(0)
            .outerRadius(arcRadius * scale)
            .startAngle(Math.PI / 2)
            .endAngle((angle + 90) * Math.PI / 180);
            
        // This is the horizon line
        g.append("line")
            .classed("rotation-compass-part", true)
            .classed("rotation-compass-horizon", true)
            .attr("x1", this._initialBounds.left - sideStickOut * scale)
            .attr("y1", yCenter)
            .attr("x2", this._initialBounds.right + sideStickOut * scale)
            .attr("y2", yCenter)
            // Set the stroke width style here so we can scale
            .style("stroke-width", strokeWidth * scale);

        // This is the vertical short line at the center
        g.append("line")
            .classed("rotation-compass-part", true)
            .classed("rotation-compass-horizon", true)
            .attr("x1", xCenter)
            .attr("y1", yCenter - centerVertical * scale)
            .attr("x2", xCenter)
            .attr("y2", yCenter + centerVertical * scale)
            // Set the stroke width style here so we can scale
            .style("stroke-width", strokeWidth * scale);

        // This is the full circle at the center
        // We only draw it if the layer is bigger than it
        if (this._initialBounds.width / 2 > arcRadius * scale) {
            g.append("circle")
                .classed("rotation-compass-part", true)
                .classed("rotation-compass-circle", true)
                .attr("cx", xCenter)
                .attr("cy", yCenter)
                .attr("r", arcRadius * scale)
                // Set the stroke width style here so we can scale
                .style("stroke-width", strokeWidth * scale);
        }

        // This is the highlighted arc in the center
        g.append("path")
            .classed("rotation-compass-part", true)
            .classed("rotation-compass-arc", true)
            .attr("d", makeArc())
            .attr("transform", function () {
                return "translate(" + xCenter + "," + yCenter + ")";
            })
            // Set the stroke width style here so we can scale
            .style("stroke-width", strokeWidth * scale);

        // This is the smaller circle at the center of the layer
        g.append("circle")
            .classed("rotation-compass-part", true)
            .classed("rotation-compass-center", true)
            .attr("cx", xCenter)
            .attr("cy", yCenter)
            .attr("r", centerRadius * scale)
            // Set the stroke width style here so we can scale
            .style("stroke-width", strokeWidth * scale);

        // This is the line that rotates with the layer
        g.append("line")
            .classed("rotation-compass-part", true)
            .classed("rotation-compass-rotate-line", true)
            .attr("x1", xCenter)
            .attr("y1", yCenter)
            .attr("x2", this._initialBounds.right + sideStickOut * scale)
            .attr("y2", yCenter)
            .attr("transform", transformString)
            // Set the stroke width style here so we can scale
            .style("stroke-width", strokeWidth * scale);
    };
    
    /**
     * Current bounds drawn by D3
     *
     * @type {Bounds}
     */
    TransformScrim.prototype._bounds = null;

    /**
     * Previous bounds drawn by D3
     *
     * @type {Bounds}
     */
    TransformScrim.prototype._oldBounds = null;

    /**
     * SVG Element D3 controls
     *
     * @type {Element}
     */
    TransformScrim.prototype._el = null;

    /**
     * Pointer back to flux controller
     *
     * @type {object}
     */
    TransformScrim.prototype._flux = null;

    /**
     * Bounds at the start of a drag operation
     *
     * @type {Bounds}
     */
    TransformScrim.prototype._initialBounds = null;

    /**
     * Bounds that are updated every time the drag quadrant changes
     *
     * @type {[type]}
     */
    TransformScrim.prototype._quadrantBounds = null;

    /**
     * Angle from center to the drag point at the beginning of rotate
     *
     * @type {number}
     */
    TransformScrim.prototype._initialAngle = 0;

    /**
     * Angle from center to the current drag point during drag rotate
     *
     * @type {number}
     */
    TransformScrim.prototype._currentAngle = 0;

    /**
     * Scaling to be applied to all stroke widths 
     * so SVG elements don't get drawn bigger as document zoom changes
     *
     * @type {number}
     */
    TransformScrim.prototype._scale = null;

    /**
     * Key of the corner being dragged
     *
     * @type {string}
     */
    TransformScrim.prototype._dragCorner = null;

    /**
     * Flag to tell whether we're currently dragging or not
     *
     * @type {boolean}
     */
    TransformScrim.prototype._dragging = null;


    module.exports = TransformScrim;
});
