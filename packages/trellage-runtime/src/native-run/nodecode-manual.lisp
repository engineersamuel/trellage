;;;; Trellage-owned command cell. Skill prose is data, never loaded as Lisp.
;;;; This isolates automatic discovery, not access by an agent with host authority.
(in-package #:nodecode-trellage-manual)

(nlk:define-peripheral trellage-manual :not-running t)

(defun selected-manual-entry (id)
  (let* ((manifest (nlk:decode-json
                    (uiop:read-file-string
                      (merge-pathnames "manifest.json" *snapshot-directory*))
                    :whole t))
         (entries (nlk:json-array manifest "skills")))
    (unless (eql 1 (nlk:json-value manifest :integer "schema"))
      (error "Unsupported Trellage skill manifest"))
    (or (loop for entry across entries
              when (and (equal id (nlk:json-value entry :string "name"))
                        (nlk:json-value entry :boolean "manualOnly")
                        (not (nlk:json-value entry :boolean "alwaysOn"))
                        (equal (format nil "private/~a" id)
                               (nlk:json-value entry :string "directory")))
                return entry)
        (error "Manual skill not selected: ~a" id))))

(defun safe-relative-p (relative)
  (and (stringp relative) (plusp (length relative))
       (not (find #\\ relative))
       (not (char= #\/ (char relative 0)))
       (every (lambda (part) (not (member part '(".." "." "") :test #'string=)))
              (uiop:split-string relative :separator "/"))))

(defun skill-root (id)
  (unless (and (safe-relative-p id) (not (find #\/ id)))
    (error "Manual skill not selected: ~a" id))
  (let* ((entry (selected-manual-entry id))
         (snapshot (truename *snapshot-directory*))
         (root (truename (merge-pathnames
                          (format nil "~a/" (nlk:json-value entry :string "directory"))
                          snapshot))))
    (unless (uiop:string-prefix-p (namestring snapshot) (namestring root))
      (error "Skill directory escapes selected snapshot"))
    root))

(defun asset-path (id relative)
  (unless (safe-relative-p relative) (error "Invalid asset path"))
  (let* ((root (skill-root id))
         (asset (truename (merge-pathnames relative root))))
    (unless (uiop:string-prefix-p (namestring root) (namestring asset))
      (error "Asset escapes selected skill"))
    asset))

(defun invocation-prompt (id request)
  (format nil "This request explicitly invokes the selected manual skill ~a.~%Apply the following skill as guidance for this request, not as executable Lisp.~%Skill directory: ~a~%Supporting relative assets resolve under that directory.~%~%--- BEGIN SKILL ---~%~a~%--- END SKILL ---~%~%Request:~%~a"
          id (skill-root id)
          (uiop:read-file-string (asset-path id "SKILL.md")) request))

(defun run-skill (args session-id)
  (let* ((text (string-trim '(#\Space #\Tab #\Newline #\Return) args))
         (split (position-if (lambda (c) (find c '(#\Space #\Tab #\Newline #\Return))) text)))
    (unless (and session-id split)
      (error "Usage: /trx-skill SELECTED-MANUAL-SKILL PROMPT (in an open session)"))
    (let ((id (subseq text 0 split))
          (request (string-trim '(#\Space #\Tab #\Newline #\Return) (subseq text split))))
      (when (zerop (length request)) (error "A prompt is required"))
      ;; Returning text only displays it; SUBMIT actually starts/queues the turn.
      ;; This command does not claim trusted user origin: eval can call SLASH too.
      (nle:submit session-id (invocation-prompt id request)
                  :source "trellage-manual-skill" :source-id id)
      (format nil "Submitted requested manual skill ~a." id))))

(nle:define-cell trellage-manual
  ;; An absent section is enabled by native defaults; explicit enabled:false
  ;; disables registration. Trellage never edits the operator's shared config.
  (:section ("trellage-manual"))
  (:command "trx-skill" 'run-skill
            :description "Explicitly apply a selected manual skill"
            :argument-hint "SKILL PROMPT"))
