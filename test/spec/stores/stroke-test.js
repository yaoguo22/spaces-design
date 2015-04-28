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

/* global module, ok, test */

define(function (require) {
    "use strict";

    var fluxxorTestHelper = require("../util/fluxxor-test-helper"),
        events = require("js/events");

    var documentDescriptorJSON = require("text!../static/document.json"),
        layersDescriptorJSON = require("text!../static/layers.json");

    var documentDescriptor = JSON.parse(documentDescriptorJSON),
        layersDescriptor = JSON.parse(layersDescriptorJSON);

    module("stores/stroke", {
        setup: fluxxorTestHelper.setup
    });

    test("Document updated", function () {
        var payload = {
            document: documentDescriptor,
            layers: layersDescriptor
        };
        this.dispatch(events.documents.DOCUMENT_UPDATED, payload);

        var strokeStore = this.flux.store("stroke"),
            l0strokes = strokeStore.getLayerStrokes(documentDescriptor.documentID, layersDescriptor[0].layerID),
            l1strokes = strokeStore.getLayerStrokes(documentDescriptor.documentID, layersDescriptor[1].layerID);

        ok(l0strokes.length > 0, "A stroke should exist");
        ok(l0strokes[0].enabled, "The first Stroke should be enabled");
        ok(l1strokes.length === 0, "The second layer should have an EMPTY strokes array");

        // Disable strokeEnabled and try again
        payload.layers[0].AGMStrokeStyleInfo.value.strokeEnabled = false;
        this.dispatch(events.documents.DOCUMENT_UPDATED, payload);

        l0strokes = strokeStore.getLayerStrokes(documentDescriptor.documentID, layersDescriptor[0].layerID);
        ok(!l0strokes[0].enabled, "The first Stroke should now be disabled");
    });
});
